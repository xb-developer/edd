import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, withTenantContext } from "../src/db/pool.js";

const admin = { organizationId: null, userId: null, isPlatformAdmin: true } as const;

interface Seeded {
  orgA: string;
  orgB: string;
  userA1: string; // member of groupA1, creates matterA1
  userA2: string; // in org A, but NOT a member of groupA1
  groupA1: string;
  matterA1: string;
  userB1: string;
  groupB1: string;
  matterB1: string;
}

let seeded: Seeded;

before(async () => {
  seeded = await withTenantContext(admin, async (client) => {
    const org = async (name: string) => {
      const { rows } = await client.query(
        "INSERT INTO organizations (auth0_org_id, name) VALUES ($1, $2) RETURNING id",
        [`auth0|test-org-${name}-${Date.now()}-${Math.random()}`, `Test Org ${name}`],
      );
      return rows[0].id as string;
    };
    const user = async (orgId: string, email: string) => {
      const { rows } = await client.query(
        "INSERT INTO users (auth0_user_id, organization_id, email) VALUES ($1, $2, $3) RETURNING id",
        [`auth0|test-user-${email}-${Date.now()}-${Math.random()}`, orgId, email],
      );
      return rows[0].id as string;
    };
    const group = async (orgId: string, name: string) => {
      const { rows } = await client.query(
        "INSERT INTO groups (organization_id, name) VALUES ($1, $2) RETURNING id",
        [orgId, name],
      );
      return rows[0].id as string;
    };
    const addMember = async (groupId: string, userId: string, orgId: string) => {
      await client.query("INSERT INTO group_members (group_id, user_id, organization_id) VALUES ($1, $2, $3)", [
        groupId,
        userId,
        orgId,
      ]);
    };

    const orgA = await org("A");
    const orgB = await org("B");
    const userA1 = await user(orgA, "a1@example.com");
    const userA2 = await user(orgA, "a2@example.com");
    const userB1 = await user(orgB, "b1@example.com");
    const groupA1 = await group(orgA, "Team A1");
    const groupB1 = await group(orgB, "Team B1");
    await addMember(groupA1, userA1, orgA);
    // userA2 deliberately NOT added to groupA1 — same org, different group.
    await addMember(groupB1, userB1, orgB);

    return { orgA, orgB, userA1, userA2, groupA1, userB1, groupB1 };
  });

  // Matters are deliberately NOT created under the platform-admin context:
  // matters_insert has no platform-admin escape hatch by design (Section 4.4
  // — even we shouldn't be able to create a matter without being a real
  // member of its group), so seeding them as the actual creating user both
  // matches real usage and exercises that policy's WITH CHECK for real.
  const matterA1 = await withTenantContext(
    { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query(
        "INSERT INTO matters (organization_id, group_id, created_by_user_id, name) VALUES ($1, $2, $3, $4) RETURNING id",
        [seeded.orgA, seeded.groupA1, seeded.userA1, "Matter A1"],
      );
      return rows[0].id as string;
    },
  );
  const matterB1 = await withTenantContext(
    { organizationId: seeded.orgB, userId: seeded.userB1, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query(
        "INSERT INTO matters (organization_id, group_id, created_by_user_id, name) VALUES ($1, $2, $3, $4) RETURNING id",
        [seeded.orgB, seeded.groupB1, seeded.userB1, "Matter B1"],
      );
      return rows[0].id as string;
    },
  );
  seeded = { ...seeded, matterA1, matterB1 };
});

after(async () => {
  await pool.end();
});

test("a user sees only their own organization's matters, even with an unfiltered query", async () => {
  const rows = await withTenantContext(
    { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false },
    async (client) => {
      // Deliberately no WHERE clause — proving RLS itself does the filtering,
      // not app-layer discipline.
      const { rows } = await client.query("SELECT id FROM matters");
      return rows;
    },
  );
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(seeded.matterA1), "should see own org's matter");
  assert.ok(!ids.includes(seeded.matterB1), "must not see the other organization's matter");
});

test("a same-org user who isn't in the matter's group cannot see it (matter-level, not just org-level, isolation)", async () => {
  const rows = await withTenantContext(
    { organizationId: seeded.orgA, userId: seeded.userA2, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query("SELECT id FROM matters");
      return rows;
    },
  );
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes(seeded.matterA1), "same-org, non-group-member must not see the matter");
});

test("a user cannot insert a matter into another organization's id, even if they try", async () => {
  await assert.rejects(
    withTenantContext({ organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false }, async (client) => {
      await client.query(
        "INSERT INTO matters (organization_id, group_id, created_by_user_id, name) VALUES ($1, $2, $3, $4)",
        [seeded.orgB, seeded.groupB1, seeded.userA1, "Attempted cross-tenant insert"],
      );
    }),
    /row-level security|new row violates/i,
  );
});

test("a user cannot read another organization's users table rows", async () => {
  const rows = await withTenantContext(
    { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query("SELECT id FROM users");
      return rows;
    },
  );
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes(seeded.userB1), "must not see the other organization's user row");
});

test("the platform admin bypass can see across organizations (sanity check the escape hatch works)", async () => {
  const rows = await withTenantContext(admin, async (client) => {
    const { rows } = await client.query("SELECT id FROM matters WHERE id = ANY($1)", [
      [seeded.matterA1, seeded.matterB1],
    ]);
    return rows;
  });
  assert.equal(rows.length, 2, "platform admin should see both matters");
});
