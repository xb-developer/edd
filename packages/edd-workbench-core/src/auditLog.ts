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
