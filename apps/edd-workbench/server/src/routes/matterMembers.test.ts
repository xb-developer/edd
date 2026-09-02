import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool, withOrgSession, initMatterGuidCounter } from "@xbundle/edd-workbench-core";
import type { EddRequestContext } from "../auth.js";

// The candidates/member-profile routes are the ones this router talks to a
// real external service (Auth0's Management API) for — mocked at the
// module boundary so these tests never make a real network call and don't
// depend on any Auth0 credentials being configured in this environment.
vi.mock("../auth0Management.js", () => ({
  listOrganizationMembers: vi.fn(),
  getUserProfile: vi.fn(),
}));
import { listOrganizationMembers, getUserProfile } from "../auth0Management.js";
import { matterMembersRouter } from "./matterMembers.js";

function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/matters/:matterId/members", matterMembersRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

async function cleanupTestOrg(orgId: string): Promise<void> {
  await withOrgSession(orgId, async (client) => {
    await client.query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await client.query("DELETE FROM matters WHERE org_id = $1", [orgId]);
  });
}

// orgId/userId are now opaque Auth0-shaped strings, not local uuids — no
// local organizations/users tables left to seed at all.
async function createTestOrgAndMatter(namePrefix: string, creatorAuth0UserId: string) {
  const orgId = `org_test_${randomUUID()}`;
  return withOrgSession(orgId, async (client) => {
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name, created_by) VALUES ($1, $2, $3) RETURNING id", [
      orgId,
      `${namePrefix} test matter`,
      creatorAuth0UserId,
    ]);
    await initMatterGuidCounter(client, matterRow.rows[0].id);
    return { orgId, matterId: matterRow.rows[0].id, creatorUserId: creatorAuth0UserId };
  });
}

describe("matterMembersRouter", () => {
  let orgIdsToClean: string[] = [];

  beforeEach(() => {
    vi.mocked(listOrganizationMembers).mockReset();
    vi.mocked(getUserProfile).mockReset();
  });

  afterEach(async () => {
    for (const id of orgIdsToClean) await cleanupTestOrg(id);
    orgIdsToClean = [];
  });

  afterAll(async () => {
    await pool.end();
  });

  it("GET / lists current members, resolved via Auth0 for email/name", async () => {
    const creatorAuth0Id = `auth0|${randomUUID()}`;
    const { orgId, matterId, creatorUserId } = await createTestOrgAndMatter("list-members", creatorAuth0Id);
    orgIdsToClean.push(orgId);

    const app = buildTestApp({ orgId, userId: creatorUserId, role: "litigation_support", email: "creator@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/members`).send();

    // The creator isn't auto-added by this raw fixture helper (that's
    // matters.ts POST /'s own job) — insert directly to test GET / in isolation.
    await withOrgSession(orgId, (client) =>
      client.query("INSERT INTO matter_members (matter_id, user_id, org_id) VALUES ($1, $2, $3)", [matterId, creatorUserId, orgId]),
    );
    vi.mocked(getUserProfile).mockResolvedValue({ email: "creator@example.com", name: null });
    const afterInsert = await request(app).get(`/api/matters/${matterId}/members`).send();

    expect(response.body).toEqual([]);
    expect(afterInsert.body).toEqual([{ userId: creatorUserId, email: "creator@example.com", name: null }]);
    expect(getUserProfile).toHaveBeenCalledWith(creatorUserId);
  });

  it("GET /candidates returns Auth0 org members not already on this matter's list", async () => {
    const creatorAuth0Id = `auth0|${randomUUID()}`;
    const { orgId, matterId, creatorUserId } = await createTestOrgAndMatter("candidates", creatorAuth0Id);
    orgIdsToClean.push(orgId);

    const alreadyMemberAuth0Id = `auth0|${randomUUID()}`;
    const eligibleAuth0Id = `auth0|${randomUUID()}`;
    await withOrgSession(orgId, (client) =>
      client.query("INSERT INTO matter_members (matter_id, user_id, org_id) VALUES ($1, $2, $3)", [matterId, alreadyMemberAuth0Id, orgId]),
    );

    vi.mocked(listOrganizationMembers).mockResolvedValue([
      { auth0UserId: alreadyMemberAuth0Id, email: "already@example.com", name: null },
      { auth0UserId: eligibleAuth0Id, email: "eligible@example.com", name: "Eligible Person" },
    ]);

    const app = buildTestApp({ orgId, userId: creatorUserId, role: "litigation_support", email: "creator@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/members/candidates`).send();

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ auth0UserId: eligibleAuth0Id, email: "eligible@example.com", name: "Eligible Person" }]);
    expect(listOrganizationMembers).toHaveBeenCalledWith(orgId);
  });

  it("POST / adds a candidate directly by their Auth0 user id — no local row to pre-create", async () => {
    const creatorAuth0Id = `auth0|${randomUUID()}`;
    const { orgId, matterId, creatorUserId } = await createTestOrgAndMatter("add-new-user", creatorAuth0Id);
    orgIdsToClean.push(orgId);

    const newAuth0Id = `auth0|${randomUUID()}`;
    const app = buildTestApp({ orgId, userId: creatorUserId, role: "litigation_support", email: "creator@example.com" });
    const response = await request(app)
      .post(`/api/matters/${matterId}/members`)
      .send({ auth0UserId: newAuth0Id, email: "brandnew@example.com", name: "Brand New" });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ userId: newAuth0Id, email: "brandnew@example.com", name: "Brand New" });

    const row = await withOrgSession(orgId, (client) =>
      client.query("SELECT user_id FROM matter_members WHERE matter_id = $1 AND user_id = $2", [matterId, newAuth0Id]),
    );
    expect(row.rows).toHaveLength(1);

    const audit = await withOrgSession(orgId, (client) => client.query("SELECT action, description FROM audit_log WHERE matter_id = $1", [matterId]));
    expect(audit.rows).toEqual([{ action: "matter.access.add", description: "Added brandnew@example.com to this matter's access list" }]);
  });

  it("403s POST / for a user who is neither admin nor this matter's creator", async () => {
    const creatorAuth0Id = `auth0|${randomUUID()}`;
    const { orgId, matterId } = await createTestOrgAndMatter("add-forbidden", creatorAuth0Id);
    orgIdsToClean.push(orgId);

    const someoneElseId = `auth0|${randomUUID()}`;
    const app = buildTestApp({ orgId, userId: someoneElseId, role: "reviewer", email: "other@example.com" });
    const response = await request(app)
      .post(`/api/matters/${matterId}/members`)
      .send({ auth0UserId: `auth0|${randomUUID()}`, email: "target@example.com" });

    expect(response.status).toBe(403);
  });

  it("admin can add even though they didn't create the matter", async () => {
    const creatorAuth0Id = `auth0|${randomUUID()}`;
    const { orgId, matterId } = await createTestOrgAndMatter("add-admin", creatorAuth0Id);
    orgIdsToClean.push(orgId);

    const adminUserId = `auth0|${randomUUID()}`;
    const app = buildTestApp({ orgId, userId: adminUserId, role: "admin", email: "admin@example.com" });
    const response = await request(app)
      .post(`/api/matters/${matterId}/members`)
      .send({ auth0UserId: `auth0|${randomUUID()}`, email: "target@example.com" });

    expect(response.status).toBe(201);
  });

  it("DELETE /:userId removes access and writes an audit row; 403s for a non-admin non-creator", async () => {
    const creatorAuth0Id = `auth0|${randomUUID()}`;
    const { orgId, matterId, creatorUserId } = await createTestOrgAndMatter("remove-member", creatorAuth0Id);
    orgIdsToClean.push(orgId);

    const targetUserId = `auth0|${randomUUID()}`;
    await withOrgSession(orgId, (client) =>
      client.query("INSERT INTO matter_members (matter_id, user_id, org_id) VALUES ($1, $2, $3)", [matterId, targetUserId, orgId]),
    );

    const strangerId = `auth0|${randomUUID()}`;
    const strangerApp = buildTestApp({ orgId, userId: strangerId, role: "reviewer", email: "stranger@example.com" });
    expect((await request(strangerApp).delete(`/api/matters/${matterId}/members/${targetUserId}`).send()).status).toBe(403);

    vi.mocked(getUserProfile).mockResolvedValue({ email: "target@example.com", name: null });
    const creatorApp = buildTestApp({ orgId, userId: creatorUserId, role: "litigation_support", email: "creator@example.com" });
    const response = await request(creatorApp).delete(`/api/matters/${matterId}/members/${targetUserId}`).send();
    expect(response.status).toBe(204);

    const remaining = await withOrgSession(orgId, (client) =>
      client.query("SELECT 1 FROM matter_members WHERE matter_id = $1 AND user_id = $2", [matterId, targetUserId]),
    );
    expect(remaining.rowCount).toBe(0);

    const audit = await withOrgSession(orgId, (client) =>
      client.query("SELECT action, description FROM audit_log WHERE matter_id = $1 AND action = 'matter.access.remove'", [matterId]),
    );
    expect(audit.rows).toEqual([{ action: "matter.access.remove", description: "Removed target@example.com from this matter's access list" }]);
  });
});
