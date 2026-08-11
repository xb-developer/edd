import { Router } from "express";
import { withOrgSession } from "@xbundle/edd-workbench-core";
import { requireRole, type Role } from "../auth.js";

export const orgInvitesRouter = Router();

const VALID_ROLES: Role[] = ["admin", "reviewer", "litigation_support"];

orgInvitesRouter.get("/", async (req, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const rows = await withOrgSession(orgId, (client) =>
      client.query(
        "SELECT id, email, role, status, created_at, accepted_at FROM org_invitations WHERE org_id = $1 ORDER BY created_at DESC",
        [orgId],
      ),
    );
    res.json(rows.rows);
  } catch (err) {
    next(err);
  }
});

// Litigation support is "admin-lite" (build plan §7): can manage
// invites/matters, same carve-out as matters.ts's create route.
//
// No Auth0 API call here — Auth0 Organizations' invitation endpoint isn't
// available on this tenant's plan (see auth.ts's resolveOrgContext for the
// full story), so there's no invite email to send through Auth0 itself.
// This just records the intended email+role; the invitee signs up (or logs
// in, if they already have an account) through Auth0's normal flow on their
// own, at whatever URL the admin shares with them out of band, and
// resolveOrgContext's pending-invitation match (by email) grants the role
// on their first authenticated request either way.
orgInvitesRouter.post("/", requireRole("admin", "litigation_support"), async (req, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { email, role } = req.body as { email?: string; role?: string };

    if (!email || !role || !VALID_ROLES.includes(role as Role)) {
      res.status(400).json({ error: "email and a valid role (admin|reviewer|litigation_support) are required" });
      return;
    }

    const existing = await withOrgSession(orgId, (client) =>
      client.query("SELECT id FROM org_invitations WHERE org_id = $1 AND email = $2 AND status = 'pending'", [orgId, email]),
    );
    if (existing.rowCount! > 0) {
      res.status(409).json({ error: "There is already a pending invitation for this email" });
      return;
    }

    const inserted = await withOrgSession(orgId, (client) =>
      client.query(
        `INSERT INTO org_invitations (org_id, email, role, invited_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, role, status, created_at`,
        [orgId, email, role, userId],
      ),
    );

    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    next(err);
  }
});
