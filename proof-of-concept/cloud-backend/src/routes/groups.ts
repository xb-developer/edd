import { Router } from "express";
import { requireOrgAdmin } from "../middleware/tenant.js";
import { logAuditForRequest } from "../audit/log.js";

export const groupsRouter = Router();

/** Creates a group within the caller's own organization (Section 4.3). */
groupsRouter.post("/", requireOrgAdmin, async (req, res) => {
  const { name } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const group = await req.withTenant!(async (client) => {
      const { rows } = await client.query(
        "INSERT INTO groups (organization_id, name) VALUES ($1, $2) RETURNING id, name, created_at",
        [req.tenant!.organizationId, name],
      );
      return rows[0];
    });
    logAuditForRequest(req, { action: "group.create", allowed: true, detail: { groupId: group.id, name } });
    res.status(201).json(group);
  } catch (err) {
    console.error("group creation failed:", err);
    res.status(500).json({ error: "group_creation_failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

/** Lists groups within the caller's own organization. */
groupsRouter.get("/", async (req, res) => {
  const rows = await req.withTenant!(async (client) => {
    const { rows } = await client.query(
      "SELECT id, name, created_at FROM groups WHERE organization_id = $1 ORDER BY created_at",
      [req.tenant!.organizationId],
    );
    return rows;
  });
  res.json(rows);
});

/** Adds an existing (same-org) user to a group. */
groupsRouter.post("/:groupId/members", requireOrgAdmin, async (req, res) => {
  const { groupId } = req.params;
  const { userId } = req.body ?? {};
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    await req.withTenant!(async (client) => {
      await client.query(
        "INSERT INTO group_members (group_id, user_id, organization_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [groupId, userId, req.tenant!.organizationId],
      );
    });
    logAuditForRequest(req, { action: "group.member.add", allowed: true, detail: { groupId, userId } });
    res.status(204).end();
  } catch (err) {
    console.error("group member add failed:", err);
    res.status(500).json({ error: "group_member_add_failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

/** Removes a user from a group. */
groupsRouter.delete("/:groupId/members/:userId", requireOrgAdmin, async (req, res) => {
  const { groupId, userId } = req.params;
  await req.withTenant!(async (client) => {
    await client.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [groupId, userId]);
  });
  logAuditForRequest(req, { action: "group.member.remove", allowed: true, detail: { groupId, userId } });
  res.status(204).end();
});

/** Lists members of a group. */
groupsRouter.get("/:groupId/members", async (req, res) => {
  const { groupId } = req.params;
  const rows = await req.withTenant!(async (client) => {
    const { rows } = await client.query(
      `SELECT u.id, u.email, u.is_org_admin
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY u.email`,
      [groupId],
    );
    return rows;
  });
  res.json(rows);
});
