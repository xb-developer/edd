import { Router } from "express";
import { requirePlatformAdmin } from "../middleware/tenant.js";
import { createOrganization, createUserInOrganization, sendPasswordResetEmail } from "../auth/managementApi.js";
import { LeadAlreadyProvisioned, LeadNotFound, provisionLead } from "../leads/provision.js";
import { logAuditForRequest } from "../audit/log.js";

export const adminRouter = Router();

adminRouter.use(requirePlatformAdmin);

/**
 * Onboards a new law firm: Auth0 Organization, our own organization row,
 * and the firm's first admin user (deployment doc Section 4.2).
 */
adminRouter.post("/organizations", async (req, res) => {
  const { name, displayName, adminEmail } = req.body ?? {};
  if (!name || !displayName || !adminEmail) {
    res.status(400).json({ error: "name, displayName and adminEmail are required" });
    return;
  }

  try {
    const org = await createOrganization(name, displayName);
    const admin = await createUserInOrganization(org.auth0OrgId, adminEmail);

    const result = await req.withTenant!(async (client) => {
      const orgRow = await client.query(
        "INSERT INTO organizations (auth0_org_id, name) VALUES ($1, $2) RETURNING id, auth0_org_id, name, created_at",
        [org.auth0OrgId, displayName],
      );
      const userRow = await client.query(
        `INSERT INTO users (auth0_user_id, organization_id, email, is_org_admin)
         VALUES ($1, $2, $3, true)
         RETURNING id, auth0_user_id, email, is_org_admin`,
        [admin.auth0UserId, orgRow.rows[0].id, adminEmail],
      );
      return { organization: orgRow.rows[0], adminUser: userRow.rows[0] };
    });

    await sendPasswordResetEmail(adminEmail);

    logAuditForRequest(req, {
      action: "admin.organization.create",
      allowed: true,
      detail: { organizationId: result.organization.id, name: displayName, adminEmail },
    });
    res.status(201).json(result);
  } catch (err) {
    console.error("organization provisioning failed:", err);
    res.status(500).json({ error: "organization_provisioning_failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

adminRouter.get("/organizations", async (req, res) => {
  const rows = await req.withTenant!(async (client) => {
    const { rows } = await client.query("SELECT id, auth0_org_id, name, created_at FROM organizations ORDER BY created_at");
    return rows;
  });
  res.json(rows);
});

/**
 * Phase 1 of the self-serve single-matter signup flow (marketing site ->
 * email capture -> Stripe payment -> this). Manually triggered by a
 * platform admin for now, once they see a payment land in Stripe - Phase 2
 * automates this same endpoint via a Stripe webhook, no change needed here.
 */
adminRouter.get("/leads", async (req, res) => {
  const rows = await req.withTenant!(async (client) => {
    const { rows } = await client.query(
      "SELECT id, email, contact_name, firm_name, status, created_at, paid_at FROM leads WHERE status != 'provisioned' ORDER BY created_at",
    );
    return rows;
  });
  res.json(rows);
});

/**
 * Provisions a paid lead into a real firm with one matter already created -
 * see src/leads/provision.ts for what this actually does and why. Manually
 * triggered by a platform admin for now (Phase 1); a Stripe webhook calling
 * the same provisionLead() function is the only change Phase 2 needs.
 */
adminRouter.post("/leads/:id/provision", async (req, res) => {
  try {
    const result = await provisionLead(req.params.id);
    logAuditForRequest(req, {
      action: "admin.lead.provision",
      allowed: true,
      detail: { leadId: req.params.id, organizationId: result.organizationId, matterId: result.matter.id },
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof LeadNotFound) {
      res.status(404).json({ error: "lead_not_found" });
      return;
    }
    if (err instanceof LeadAlreadyProvisioned) {
      logAuditForRequest(req, {
        action: "admin.lead.provision",
        allowed: false,
        detail: { leadId: req.params.id, reason: "already_provisioned" },
      });
      res.status(409).json({ error: "already_provisioned" });
      return;
    }
    console.error("lead provisioning failed:", err);
    res.status(500).json({ error: "lead_provisioning_failed", detail: err instanceof Error ? err.message : String(err) });
  }
});
