import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { pool, withTenantContext } from "../src/db/pool.js";
import { devAuthBypass } from "../src/auth/devBypass.js";

const admin = { organizationId: null, userId: null, isPlatformAdmin: true } as const;
const DEV_AUTH0_USER_ID = "local-dev|bypass-user";

after(async () => {
  // Leaves no trace in a DB other tests/dev sessions share.
  await withTenantContext(admin, async (client) => {
    const { rows } = await client.query("SELECT id, organization_id FROM users WHERE auth0_user_id = $1", [
      DEV_AUTH0_USER_ID,
    ]);
    for (const row of rows) {
      await client.query("DELETE FROM matters WHERE created_by_user_id = $1", [row.id]);
      await client.query("DELETE FROM group_members WHERE user_id = $1", [row.id]);
      await client.query("DELETE FROM groups WHERE organization_id = $1", [row.organization_id]);
      await client.query("DELETE FROM users WHERE id = $1", [row.id]);
      await client.query("DELETE FROM organizations WHERE id = $1", [row.organization_id]);
    }
  });
  await pool.end();
});

function fakeReqRes(): { req: Request; next: () => void } {
  const req = {} as Request;
  const next = () => {};
  return { req, next };
}

test("devAuthBypass seeds exactly one complete org/user/group/matter, even under concurrent callers", async () => {
  // Regression test for a real race: the SPA fires several requests in
  // parallel on load, each hitting this middleware at nearly the same
  // moment. Before the fix, concurrent callers could race the seeding
  // logic and leave a half-provisioned org (user created, matter never
  // inserted) that a boolean "already seeded" flag then treated as done
  // forever.
  const calls = Array.from({ length: 8 }, () => fakeReqRes());
  await Promise.all(calls.map(({ req, next }) => devAuthBypass(req, {} as Response, next)));

  for (const { req } of calls) {
    assert.equal(req.auth?.auth0UserId, DEV_AUTH0_USER_ID);
  }

  const state = await withTenantContext(admin, async (client) => {
    const users = await client.query("SELECT id, organization_id FROM users WHERE auth0_user_id = $1", [
      DEV_AUTH0_USER_ID,
    ]);
    return users.rows;
  });
  assert.equal(state.length, 1, "exactly one dev user must exist, not zero and not several from a race");

  const { organization_id: organizationId, id: userId } = state[0];

  const { groups, matters } = await withTenantContext(admin, async (client) => {
    const groups = await client.query("SELECT id FROM groups WHERE organization_id = $1", [organizationId]);
    const matters = await client.query(
      "SELECT id, created_by_user_id FROM matters WHERE organization_id = $1",
      [organizationId],
    );
    return { groups: groups.rows, matters: matters.rows };
  });

  assert.equal(groups.length, 1, "exactly one group must exist");
  assert.equal(matters.length, 1, "the matter insert must have actually completed, not been silently skipped");
  assert.equal(matters[0].created_by_user_id, userId);
});
