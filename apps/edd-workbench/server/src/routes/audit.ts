import { Router } from "express";
import { withOrgSession, recordAuditEvent } from "@xbundle/edd-workbench-core";

// Mounted at /api/audit — org-scoped but not matter-scoped, unlike
// everything else that writes an audit row. Logout has no server-side
// event of its own to hook (this app's login/logout is purely client-side
// Auth0 redirect) — the client calls this itself, right before triggering
// the actual Auth0 logout redirect, best-effort (never blocking logout on
// a failure here — see EddWorkbenchWorkspace.tsx's handler).
export const auditRouter = Router();

auditRouter.post("/logout", async (req, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    await withOrgSession(orgId, (client) =>
      recordAuditEvent(client, { orgId, actorUserId: userId, action: "logout", description: "User logged out" }),
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
