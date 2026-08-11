import type { Request } from "express";
import { withTenantContext, type TenantContext } from "../db/pool.js";

export interface AuditEntry {
  organizationId: string | null;
  userId: string | null;
  matterId?: string | null;
  action: string;
  allowed: boolean;
  detail?: Record<string, unknown>;
}

/**
 * Writes one audit_log row. `writeAs` sets the RLS session for the INSERT
 * itself and is usually just the entry's own organizationId/userId, but the
 * two are kept separate because some events (a caller with no matching
 * account, a platform-admin action with no organization) have nothing valid
 * to set organization_id/user_id to while still needing a context that
 * satisfies audit_insert's WITH CHECK (org match OR platform admin).
 *
 * Never throws — a failure to log must not take down the request whose
 * action it's describing.
 */
export async function logAudit(writeAs: TenantContext, entry: AuditEntry): Promise<void> {
  try {
    await withTenantContext(writeAs, async (client) => {
      await client.query(
        `INSERT INTO audit_log (organization_id, user_id, matter_id, action, allowed, detail)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          entry.organizationId,
          entry.userId,
          entry.matterId ?? null,
          entry.action,
          entry.allowed,
          entry.detail ? JSON.stringify(entry.detail) : null,
        ],
      );
    });
  } catch (err) {
    console.error("audit log write failed:", err);
  }
}

/** Convenience wrapper for the common case: logging against the tenant already resolved on `req`. */
export async function logAuditForRequest(
  req: Request,
  entry: { matterId?: string | null; action: string; allowed: boolean; detail?: Record<string, unknown> },
): Promise<void> {
  const tenant = req.tenant;
  if (!tenant) return;
  await logAudit(tenant, {
    organizationId: tenant.organizationId,
    userId: tenant.userId,
    ...entry,
  });
}
