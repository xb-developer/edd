import type { PoolClient } from "pg";

/**
 * A plain string union, not a DB enum — a future action nobody has thought
 * of yet is just one more member here plus one more call site, no
 * migration required. `details` (see recordAuditEvent) absorbs whatever
 * type-specific context that new action needs.
 */
export type AuditAction =
  | "logout"
  | "matter.create"
  | "matter.delete"
  | "matter.load"
  | "document.upload"
  | "document.delete"
  | "document.retry_ingest"
  | "matter.access.add"
  | "matter.access.remove";

/**
 * Always call this inside the SAME transaction as the action it records
 * (the caller's own `withOrgSession` block) — the audit row and the action
 * itself must commit or roll back together, never one without the other.
 * `description` is rendered by the caller at write time (e.g. with a real
 * filename baked in as text) so the record stays meaningful even after
 * whatever it references (matter/document/actor) is later deleted — see
 * migration 023's ON DELETE SET NULL on those columns.
 */
export interface AuditEvent {
  orgId: string;
  actorUserId: string;
  matterId?: string | null;
  documentId?: string | null;
  action: AuditAction;
  description: string;
  details?: Record<string, unknown>;
}

/**
 * Batched form of recordAuditEvent, with identical transaction semantics —
 * one statement instead of one per event.
 *
 * Exists because the delete paths (documents.ts's
 * deleteDocumentsWithS3Cleanup, matters.ts's matter cascade) record one row
 * per document actually removed, INCLUDING every cascade-deleted
 * descendant. Awaiting recordAuditEvent in a loop made deleting a
 * 50,000-document matter 50,000 sequential round-trips inside a single
 * open transaction, holding its locks for the duration. Same
 * `INSERT ... SELECT FROM unnest(...)` shape documentChunks.ts already
 * uses for the same reason.
 *
 * Empty input is a no-op, not an empty INSERT — callers pass whatever the
 * delete happened to match, which is legitimately sometimes nothing.
 */
export async function recordAuditEvents(client: PoolClient, events: readonly AuditEvent[]): Promise<void> {
  if (events.length === 0) return;
  await client.query(
    `INSERT INTO audit_log (org_id, actor_user_id, matter_id, document_id, action, description, details)
     SELECT * FROM unnest($1::text[], $2::text[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::jsonb[])`,
    [
      events.map((e) => e.orgId),
      events.map((e) => e.actorUserId),
      events.map((e) => e.matterId ?? null),
      events.map((e) => e.documentId ?? null),
      events.map((e) => e.action),
      events.map((e) => e.description),
      events.map((e) => (e.details ? JSON.stringify(e.details) : null)),
    ],
  );
}

export async function recordAuditEvent(
  client: PoolClient,
  params: {
    orgId: string;
    actorUserId: string;
    matterId?: string | null;
    documentId?: string | null;
    action: AuditAction;
    description: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (org_id, actor_user_id, matter_id, document_id, action, description, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.orgId,
      params.actorUserId,
      params.matterId ?? null,
      params.documentId ?? null,
      params.action,
      params.description,
      params.details ? JSON.stringify(params.details) : null,
    ],
  );
}
