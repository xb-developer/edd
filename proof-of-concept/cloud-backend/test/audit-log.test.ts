import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, withTenantContext } from "../src/db/pool.js";
import { logAudit } from "../src/audit/log.js";

const admin = { organizationId: null, userId: null, isPlatformAdmin: true } as const;

interface Seeded {
  orgA: string;
  userA1: string;
  orgB: string;
  userB1: string;
}

let seeded: Seeded;

// Unique per test run (tests share one Postgres instance across runs, same
// convention as isolation.test.ts/collaboration.test.ts) so a leftover row
// from a previous run can't be mistaken for this run's row.
const runId = `${Date.now()}-${Math.random()}`;
const actionAllowed = `test.allowed-${runId}`;
const actionDenied = `test.denied-${runId}`;
const actionOrgBOnly = `test.orgb-only-${runId}`;
const actionMismatchedOrg = `test.mismatched-org-${runId}`;

before(async () => {
  seeded = await withTenantContext(admin, async (client) => {
    const org = async (name: string) => {
      const { rows } = await client.query(
        "INSERT INTO organizations (auth0_org_id, name) VALUES ($1, $2) RETURNING id",
        [`auth0|audit-org-${name}-${Date.now()}-${Math.random()}`, `Audit Org ${name}`],
      );
      return rows[0].id as string;
    };
    const user = async (orgId: string, email: string) => {
      const { rows } = await client.query(
        "INSERT INTO users (auth0_user_id, organization_id, email) VALUES ($1, $2, $3) RETURNING id",
        [`auth0|audit-user-${email}-${Date.now()}-${Math.random()}`, orgId, email],
      );
      return rows[0].id as string;
    };
    const orgA = await org("A");
    const orgB = await org("B");
    const userA1 = await user(orgA, "audit-a1@example.com");
    const userB1 = await user(orgB, "audit-b1@example.com");
    return { orgA, orgB, userA1, userB1 };
  });
});

after(async () => {
  await pool.end();
});

test("logAudit writes an allowed=true row visible to the same org", async () => {
  await logAudit(
    { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false },
    { organizationId: seeded.orgA, userId: seeded.userA1, action: actionAllowed, allowed: true, detail: { note: "hello" } },
  );

  const rows = await withTenantContext(
    { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query(
        "SELECT action, allowed, detail FROM audit_log WHERE organization_id = $1 AND action = $2",
        [seeded.orgA, actionAllowed],
      );
      return rows;
    },
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].allowed, true);
  assert.deepEqual(rows[0].detail, { note: "hello" });
});

test("logAudit writes an allowed=false (denial) row under a platform-admin write context, attributable to no org", async () => {
  await logAudit(
    { organizationId: null, userId: null, isPlatformAdmin: true },
    { organizationId: null, userId: null, action: actionDenied, allowed: false, detail: { reason: "no_matching_account" } },
  );

  const rows = await withTenantContext(admin, async (client) => {
    const { rows } = await client.query("SELECT action, allowed, organization_id FROM audit_log WHERE action = $1", [
      actionDenied,
    ]);
    return rows;
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].allowed, false);
  assert.equal(rows[0].organization_id, null);
});

test("audit_log RLS isolates entries between organizations", async () => {
  await logAudit(
    { organizationId: seeded.orgB, userId: seeded.userB1, isPlatformAdmin: false },
    { organizationId: seeded.orgB, userId: seeded.userB1, action: actionOrgBOnly, allowed: true },
  );

  const asOrgA = await withTenantContext(
    { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query("SELECT 1 FROM audit_log WHERE action = $1", [actionOrgBOnly]);
      return rows;
    },
  );
  assert.equal(asOrgA.length, 0, "org A must not see org B's audit entries");

  const asOrgB = await withTenantContext(
    { organizationId: seeded.orgB, userId: seeded.userB1, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query("SELECT 1 FROM audit_log WHERE action = $1", [actionOrgBOnly]);
      return rows;
    },
  );
  assert.equal(asOrgB.length, 1, "org B must see its own audit entry");
});

test("logAudit never throws, even when the write context can't satisfy RLS", async () => {
  await assert.doesNotReject(
    logAudit(
      { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false },
      { organizationId: seeded.orgB, userId: null, action: actionMismatchedOrg, allowed: true },
    ),
  );

  const rows = await withTenantContext(admin, async (client) => {
    const { rows } = await client.query("SELECT 1 FROM audit_log WHERE action = $1", [actionMismatchedOrg]);
    return rows;
  });
  assert.equal(rows.length, 0, "the RLS-rejected insert must not have silently succeeded under a different org");
});
