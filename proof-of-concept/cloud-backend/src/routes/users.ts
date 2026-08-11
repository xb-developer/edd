import { Router } from "express";
import { requireOrgAdmin } from "../middleware/tenant.js";
import { createUserInOrganization, sendPasswordResetEmail } from "../auth/managementApi.js";
import { logAuditForRequest } from "../audit/log.js";

export const usersRouter = Router();

/** Firm admin creates a user within their own organization (Section 4.2). */
usersRouter.post("/", requireOrgAdmin, async (req, res) => {
  const { email } = req.body ?? {};
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  try {
    const orgRow = await req.withTenant!(async (client) => {
      const { rows } = await client.query("SELECT auth0_org_id FROM organizations WHERE id = $1", [
        req.tenant!.organizationId,
      ]);
      return rows[0] as { auth0_org_id: string } | undefined;
    });
    if (!orgRow) {
      res.status(404).json({ error: "organization_not_found" });
      return;
    }

    const created = await createUserInOrganization(orgRow.auth0_org_id, email);

    const user = await req.withTenant!(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO users (auth0_user_id, organization_id, email, is_org_admin)
         VALUES ($1, $2, $3, false)
         RETURNING id, auth0_user_id, email, is_org_admin, created_at`,
        [created.auth0UserId, req.tenant!.organizationId, email],
      );
      return rows[0];
    });

    await sendPasswordResetEmail(email);

    logAuditForRequest(req, { action: "user.create", allowed: true, detail: { userId: user.id, email } });
    res.status(201).json(user);
  } catch (err) {
    console.error("user provisioning failed:", err);
    res.status(500).json({ error: "user_provisioning_failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

/** Lists users within the caller's own organization. */
usersRouter.get("/", async (req, res) => {
  const rows = await req.withTenant!(async (client) => {
    const { rows } = await client.query(
      "SELECT id, email, is_org_admin, created_at FROM users WHERE organization_id = $1 ORDER BY created_at",
      [req.tenant!.organizationId],
    );
    return rows;
  });
  res.json(rows);
});
