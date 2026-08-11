import "./loadEnv.js";
import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import { withOrgSession } from "./session.js";

// Bootstraps the very first organization + admin membership. There's no
// invite/admin UI yet (that's beyond Milestone 0's matters-CRUD scope), and
// the server only ever creates a `users` row as a side effect of a *request
// that already has a matching org_memberships row* to check (see auth.ts's
// resolveOrgContext) — so a brand-new org's first-ever login always 403s
// until something has created that first membership out of band. This is
// that "something," run once per new organization.
function readArg(name: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  const value = idx !== -1 ? process.argv[idx + 1] : undefined;
  if (!value) throw new Error(`Missing required --${name} argument`);
  return value;
}

async function run(): Promise<void> {
  const name = readArg("name");
  const auth0OrgId = readArg("auth0-org-id");
  const adminAuth0UserId = readArg("admin-auth0-user-id");
  const adminEmail = readArg("admin-email");

  // Generated here, not by the organizations table's own default, so the
  // same id can be used to open the RLS session below in one transaction —
  // organizations itself has no RLS (see 002_organizations.sql), but
  // org_memberships does, and needs app.current_org_id set to exactly the
  // org being created before its INSERT will pass that policy.
  const orgId = randomUUID();

  await withOrgSession(orgId, async (client) => {
    await client.query("INSERT INTO organizations (id, name, auth0_org_id) VALUES ($1, $2, $3)", [
      orgId,
      name,
      auth0OrgId,
    ]);

    const userRow = await client.query<{ id: string }>(
      `INSERT INTO users (auth0_user_id, email)
       VALUES ($1, $2)
       ON CONFLICT (auth0_user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [adminAuth0UserId, adminEmail],
    );

    await client.query("INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, 'admin')", [
      orgId,
      userRow.rows[0].id,
    ]);
  });

  console.log(`Seeded organization "${name}" (${orgId}) with admin ${adminEmail} (${adminAuth0UserId})`);
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
