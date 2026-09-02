import { Router, type Request } from "express";
import { withOrgSession, recordAuditEvent } from "@xbundle/edd-workbench-core";

// mergeParams — mounted at /api/matters/:matterId/audit-load, behind
// requireMatterAccess (index.ts), so a denied load attempt never produces a
// false "loaded" record — the client only ever gets here once it's already
// allowed to open the matter.
export const matterAuditRouter = Router({ mergeParams: true });

matterAuditRouter.post("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { matterId } = req.params;
    await withOrgSession(orgId, async (client) => {
      const matter = await client.query<{ name: string }>("SELECT name FROM matters WHERE id = $1", [matterId]);
      await recordAuditEvent(client, {
        orgId,
        actorUserId: userId,
        matterId,
        action: "matter.load",
        description: `Loaded matter "${matter.rows[0]?.name ?? matterId}"`,
      });
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
