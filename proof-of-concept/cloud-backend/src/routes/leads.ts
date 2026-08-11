import { Router } from "express";
import { pool } from "../db/pool.js";
import { LeadAlreadyProvisioned, LeadNotFound, provisionLead } from "../leads/provision.js";

// Deliberately public - runs before requireAuth/resolveTenant in index.ts,
// same reasoning as localDownloadRouter in documents.ts. A lead has no
// account yet, so there's no token to check and no tenant context to set;
// this queries `pool` directly rather than through withTenantContext.
export const leadsRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

leadsRouter.post("/leads", async (req, res) => {
  const { email, contactName, firmName } = req.body ?? {};
  if (typeof email !== "string" || typeof contactName !== "string" || typeof firmName !== "string") {
    res.status(400).json({ error: "email, contactName and firmName are required" });
    return;
  }
  const trimmedEmail = email.trim().toLowerCase();
  const trimmedName = contactName.trim();
  const trimmedFirm = firmName.trim();
  if (!trimmedEmail || !trimmedName || !trimmedFirm) {
    res.status(400).json({ error: "email, contactName and firmName are required" });
    return;
  }
  if (!EMAIL_RE.test(trimmedEmail)) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO leads (email, contact_name, firm_name) VALUES ($1, $2, $3) RETURNING id`,
      [trimmedEmail, trimmedName, trimmedFirm],
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error("lead capture failed:", err);
    res.status(500).json({ error: "lead_capture_failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Stands in for a real Stripe Payment Link + webhook for local alpha
 * testing only - simulates "payment confirmed" and immediately provisions
 * the account, so the whole signup -> pay -> matter-ready flow can be
 * exercised on a laptop with no Stripe account and no deployment. Hard
 * NODE_ENV gate below: this must never exist in a real deployment, since it
 * would let anyone provision a free account without paying. When real
 * Stripe is wired up, this route is deleted, not adapted - a genuine
 * webhook verifies a signature before calling provisionLead(); this route
 * deliberately has no such check because it isn't real payment.
 */
leadsRouter.post("/leads/:id/mock-checkout", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  try {
    // Conditional on status = 'captured' so an already-provisioned (or
    // already-paid) lead's status is never clobbered back to 'paid' - that
    // would erase provisionLead()'s own "already provisioned" guard and let
    // this get called twice, which really did happen while testing this
    // and produced a real Auth0 "organization already exists" conflict
    // instead of a clean 409.
    const { rowCount } = await pool.query(
      "UPDATE leads SET status = 'paid', paid_at = now() WHERE id = $1 AND status = 'captured'",
      [req.params.id],
    );
    if (rowCount === 0) {
      const { rows } = await pool.query("SELECT status FROM leads WHERE id = $1", [req.params.id]);
      if (rows.length === 0) {
        res.status(404).json({ error: "lead_not_found" });
        return;
      }
      if (rows[0].status === "provisioned") {
        res.status(409).json({ error: "already_provisioned" });
        return;
      }
      // status is 'paid' or 'abandoned' but not yet provisioned (e.g. a
      // previous attempt crashed after payment but before provisioning) -
      // fall through and let provisionLead retry it.
    }
    const result = await provisionLead(req.params.id);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof LeadNotFound) {
      res.status(404).json({ error: "lead_not_found" });
      return;
    }
    if (err instanceof LeadAlreadyProvisioned) {
      res.status(409).json({ error: "already_provisioned" });
      return;
    }
    console.error("mock checkout failed:", err);
    res.status(500).json({ error: "mock_checkout_failed", detail: err instanceof Error ? err.message : String(err) });
  }
});
