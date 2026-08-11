import { Router } from "express";
import { requireOrgAdmin } from "../middleware/tenant.js";

export const auditLogRouter = Router();

/**
 * Lets a firm's own admin review their organization's audit trail (who did
 * what, and what was blocked) - the audit_select RLS policy already scopes
 * this to the caller's own organization_id, this route just exposes it.
 * Platform admins see every organization's entries the same way admin
 * routes already do.
 */
auditLogRouter.get("/", requireOrgAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 500);
  const rows = await req.withTenant!(async (client) => {
    const { rows } = await client.query(
      `SELECT id, organization_id, user_id, matter_id, action, allowed, detail, created_at
       FROM audit_log
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  });
  res.json(rows);
});
