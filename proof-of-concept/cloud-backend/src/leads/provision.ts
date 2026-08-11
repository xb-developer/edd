import { pool, withTenantContext } from "../db/pool.js";
import { createOrganization, createUserInOrganization, sendPasswordResetEmail } from "../auth/managementApi.js";

export class LeadNotFound extends Error {}
export class LeadAlreadyProvisioned extends Error {}

interface LeadRow {
  id: string;
  email: string;
  contact_name: string;
  firm_name: string;
  status: string;
  organization_id: string | null;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || "firm";
}

/**
 * Turns a paid lead into a real firm with exactly one matter already
 * created and ready to upload into (Logikcull's "account exists, project
 * already there" self-serve pattern - see the signup-flow research). Shared
 * by the real admin-triggered endpoint (Phase 1, and eventually a Stripe
 * webhook) and the local-only mock-checkout endpoint used for alpha testing
 * - both need identical behaviour, only how they get *invoked* differs.
 *
 * The org/user/group/group_members inserts run under a platform-admin
 * tenant context (every one of those tables' INSERT policies has a
 * platform-admin bypass, confirmed by reading migrations/001_init.sql).
 * matters_insert deliberately does NOT have one - every matter must have a
 * real, accountable creator - so that one insert runs under a tenant
 * context built for the just-created admin instead, satisfying that policy
 * honestly rather than weakening it.
 */
export async function provisionLead(leadId: string) {
  const lead = await withTenantContext({ organizationId: null, userId: null, isPlatformAdmin: true }, async (client) => {
    const { rows } = await client.query("SELECT * FROM leads WHERE id = $1", [leadId]);
    return rows[0] as LeadRow | undefined;
  });
  if (!lead) throw new LeadNotFound(leadId);
  // Checked on organization_id, not just status === 'provisioned' - a
  // caller mutating status without also clearing organization_id (as the
  // mock-checkout route briefly did, corrupting a test row from
  // 'provisioned' back to 'paid') would otherwise let this run twice and
  // hit a real Auth0 "organization already exists" conflict instead of a
  // clean, expected error.
  if (lead.organization_id || lead.status === "provisioned") throw new LeadAlreadyProvisioned(leadId);

  const auth0OrgName = `${slugify(lead.firm_name)}-${lead.id.slice(0, 8)}`;
  const org = await createOrganization(auth0OrgName, lead.firm_name);
  const admin = await createUserInOrganization(org.auth0OrgId, lead.email);

  const { organizationId, adminUser, group } = await withTenantContext(
    { organizationId: null, userId: null, isPlatformAdmin: true },
    async (client) => {
      const orgRow = await client.query(
        "INSERT INTO organizations (auth0_org_id, name) VALUES ($1, $2) RETURNING id, auth0_org_id, name, created_at",
        [org.auth0OrgId, lead.firm_name],
      );
      const organizationId = orgRow.rows[0].id;
      const userRow = await client.query(
        `INSERT INTO users (auth0_user_id, organization_id, email, is_org_admin)
         VALUES ($1, $2, $3, true)
         RETURNING id, auth0_user_id, email, is_org_admin`,
        [admin.auth0UserId, organizationId, lead.email],
      );
      const groupRow = await client.query(
        "INSERT INTO groups (organization_id, name) VALUES ($1, $2) RETURNING id, name, created_at",
        [organizationId, "Matter Team"],
      );
      await client.query("INSERT INTO group_members (group_id, user_id, organization_id) VALUES ($1, $2, $3)", [
        groupRow.rows[0].id,
        userRow.rows[0].id,
        organizationId,
      ]);
      return { organizationId, adminUser: userRow.rows[0], group: groupRow.rows[0] };
    },
  );

  const matter = await withTenantContext({ organizationId, userId: adminUser.id, isPlatformAdmin: false }, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO matters (organization_id, group_id, created_by_user_id, name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, group_id, created_by_user_id, created_at`,
      [organizationId, group.id, adminUser.id, lead.firm_name],
    );
    return rows[0];
  });

  await pool.query("UPDATE leads SET status = 'provisioned', organization_id = $1, provisioned_at = now() WHERE id = $2", [
    organizationId,
    lead.id,
  ]);

  await sendPasswordResetEmail(lead.email);

  return { organizationId, adminUser, group, matter };
}
