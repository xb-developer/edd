import { Router } from "express";
import { logAuditForRequest } from "../audit/log.js";

export const mattersRouter = Router();

/**
 * Creates a matter within the caller's own group. The app-layer check below
 * (is the caller actually a member of groupId?) is deliberately duplicated
 * by the matters_insert RLS policy (Section 5.1/5) — either one failing
 * blocks the insert, so a bug in this handler alone can't create a matter
 * the caller shouldn't be able to create.
 */
mattersRouter.post("/", async (req, res) => {
  const { name, groupId } = req.body ?? {};
  if (!name || !groupId) {
    res.status(400).json({ error: "name and groupId are required" });
    return;
  }
  try {
    const matter = await req.withTenant!(async (client) => {
      const membership = await client.query(
        "SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2",
        [groupId, req.tenant!.userId],
      );
      if (membership.rowCount === 0) {
        throw Object.assign(new Error("not_a_group_member"), { status: 403 });
      }
      const { rows } = await client.query(
        `INSERT INTO matters (organization_id, group_id, created_by_user_id, name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, group_id, created_by_user_id, created_at`,
        [req.tenant!.organizationId, groupId, req.tenant!.userId, name],
      );
      return rows[0];
    });
    logAuditForRequest(req, { matterId: matter.id, action: "matter.create", allowed: true, detail: { name } });
    res.status(201).json(matter);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) console.error("matter creation failed:", err);
    if (status === 403) {
      logAuditForRequest(req, { action: "matter.create", allowed: false, detail: { name, groupId, reason: "not_a_group_member" } });
    }
    res.status(status).json({
      error: status === 403 ? "not_a_group_member" : "matter_creation_failed",
      ...(status >= 500 ? { detail: err instanceof Error ? err.message : String(err) } : {}),
    });
  }
});

/**
 * Lists matters visible to the caller. The WHERE clause here only scopes to
 * organization for readability/index use — the actual "creator or group
 * member" narrowing is enforced by the matters_select RLS policy itself, so
 * this endpoint can't accidentally return a matter the caller shouldn't see
 * even if this query were rewritten to drop the group check entirely.
 */
mattersRouter.get("/", async (req, res) => {
  const rows = await req.withTenant!(async (client) => {
    const { rows } = await client.query(
      "SELECT id, name, group_id, created_by_user_id, created_at FROM matters WHERE organization_id = $1 ORDER BY created_at DESC",
      [req.tenant!.organizationId],
    );
    return rows;
  });
  res.json(rows);
});

mattersRouter.get("/:id", async (req, res) => {
  const { id } = req.params;
  const matter = await req.withTenant!(async (client) => {
    const { rows } = await client.query(
      "SELECT id, name, group_id, created_by_user_id, created_at FROM matters WHERE id = $1",
      [id],
    );
    return rows[0];
  });
  if (!matter) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(matter);
});
