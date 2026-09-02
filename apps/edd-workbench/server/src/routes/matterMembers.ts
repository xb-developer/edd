import { Router, type Request } from "express";
import { withOrgSession, recordAuditEvent } from "@xbundle/edd-workbench-core";
import { listOrganizationMembers, getUserProfile } from "../auth0Management.js";

// mergeParams — mounted at /api/matters/:matterId/members; :matterId comes
// from the parent mount path, matching documents.ts/tags.ts's own convention.
export const matterMembersRouter = Router({ mergeParams: true });

/** Admin, or whoever created this matter — the one gate narrower than plain requireMatterAccess, which only checks "has access at all." */
async function canManageMembers(orgId: string, matterId: string, userId: string, role: string): Promise<boolean> {
  if (role === "admin") return true;
  const matter = await withOrgSession(orgId, (client) => client.query<{ created_by: string | null }>("SELECT created_by FROM matters WHERE id = $1", [matterId]));
  return matter.rows[0]?.created_by === userId;
}

// No local users table to join for email/name — resolved from Auth0
// instead, one Management API call per member (cached, see
// auth0Management.ts). Matter access lists are expected to be small
// (a handful of people), so per-member parallel calls are simpler than a
// batch-lookup query, and cheap once warm.
matterMembersRouter.get("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId } = req.params;
    const rows = await withOrgSession(orgId, (client) =>
      client.query<{ user_id: string }>("SELECT user_id FROM matter_members WHERE matter_id = $1", [matterId]),
    );
    const members = await Promise.all(
      rows.rows.map(async (r) => {
        const profile = await getUserProfile(r.user_id);
        return { userId: r.user_id, email: profile?.email ?? r.user_id, name: profile?.name ?? null };
      }),
    );
    members.sort((a, b) => a.email.localeCompare(b.email));
    res.json(members);
  } catch (err) {
    next(err);
  }
});

// The dropdown's data source — org members (per Auth0, the sole source of
// truth for that) who aren't already on this matter's list.
matterMembersRouter.get("/candidates", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId } = req.params;

    const auth0Members = await listOrganizationMembers(orgId);
    if (auth0Members.length === 0) {
      res.json([]);
      return;
    }

    const existing = await withOrgSession(orgId, (client) =>
      client.query<{ user_id: string }>("SELECT user_id FROM matter_members WHERE matter_id = $1", [matterId]),
    );
    const alreadyHasAccess = new Set(existing.rows.map((r) => r.user_id));

    res.json(auth0Members.filter((m) => !alreadyHasAccess.has(m.auth0UserId)).map((m) => ({ auth0UserId: m.auth0UserId, email: m.email, name: m.name })));
  } catch (err) {
    next(err);
  }
});

matterMembersRouter.post("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId, userId, role } = req.eddContext!;
    const { matterId } = req.params;
    const { auth0UserId, email, name } = req.body as { auth0UserId?: string; email?: string; name?: string | null };
    if (!auth0UserId || !email) {
      res.status(400).json({ error: "auth0UserId and email are required" });
      return;
    }

    if (!(await canManageMembers(orgId, matterId, userId, role))) {
      res.status(403).json({ error: "Only an admin or this matter's creator can manage its access list" });
      return;
    }

    await withOrgSession(orgId, async (client) => {
      await client.query(
        `INSERT INTO matter_members (matter_id, user_id, org_id, added_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (matter_id, user_id) DO NOTHING`,
        [matterId, auth0UserId, orgId, userId],
      );

      await recordAuditEvent(client, {
        orgId,
        actorUserId: userId,
        matterId,
        action: "matter.access.add",
        description: `Added ${email} to this matter's access list`,
        details: { targetEmail: email },
      });
    });

    res.status(201).json({ userId: auth0UserId, email, name: name ?? null });
  } catch (err) {
    next(err);
  }
});

matterMembersRouter.delete("/:userId", async (req: Request<{ matterId: string; userId: string }>, res, next) => {
  try {
    const { orgId, userId, role } = req.eddContext!;
    const { matterId, userId: targetUserId } = req.params;

    if (!(await canManageMembers(orgId, matterId, userId, role))) {
      res.status(403).json({ error: "Only an admin or this matter's creator can manage its access list" });
      return;
    }

    const targetProfile = await getUserProfile(targetUserId);

    await withOrgSession(orgId, async (client) => {
      const deleted = await client.query("DELETE FROM matter_members WHERE matter_id = $1 AND user_id = $2", [matterId, targetUserId]);
      if (deleted.rowCount !== 0) {
        await recordAuditEvent(client, {
          orgId,
          actorUserId: userId,
          matterId,
          action: "matter.access.remove",
          description: `Removed ${targetProfile?.email ?? targetUserId} from this matter's access list`,
          details: { targetEmail: targetProfile?.email ?? null },
        });
      }
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
