import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool, withOrgSession, initMatterGuidCounter } from "@xbundle/edd-workbench-core";
import { requireMatterAccess } from "./auth.js";
import { documentsRouter } from "./routes/documents.js";
import { tagsRouter } from "./routes/tags.js";
import { documentTagsRouter } from "./routes/documentTags.js";
import { exportsRouter } from "./routes/exports.js";
import type { EddRequestContext } from "./auth.js";

// resolveOrgContext's only external dependency now — no local
// users/organizations/org_memberships/org_invitations tables left to seed.
vi.mock("./auth0Management.js", () => ({
  getOrganizationMemberContext: vi.fn(),
}));
import { getOrganizationMemberContext } from "./auth0Management.js";
import { resolveOrgContext } from "./auth.js";

// Mirrors index.ts's real wiring exactly — requireMatterAccess mounted once,
// in front of every :matterId-scoped router — so this proves the actual
// production wiring, not just requireMatterAccess in isolation. The
// Auth0-JWT half of the real chain (requireValidToken/resolveOrgContext) is
// swapped for direct eddContext injection, same as every other test file in
// this codebase — that half is unrelated to what's being proven here.
function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/matters/:matterId", requireMatterAccess());
  app.use("/api/matters/:matterId/documents", documentsRouter);
  app.use("/api/matters/:matterId/tags", tagsRouter);
  app.use("/api/matters/:matterId/document-tags", documentTagsRouter);
  app.use("/api/matters/:matterId/exports", exportsRouter);
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

// orgId/userId are opaque Auth0-shaped strings now — no local
// organizations/users rows to create at all.
async function createTestOrgMatterAndUser(namePrefix: string) {
  const orgId = `org_test_${randomUUID()}`;
  const userId = `auth0|${randomUUID()}`;
  return withOrgSession(orgId, async (client) => {
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name, created_by) VALUES ($1, $2, $3) RETURNING id", [
      orgId,
      `${namePrefix} test matter`,
      userId,
    ]);
    await initMatterGuidCounter(client, matterRow.rows[0].id);
    return { orgId, matterId: matterRow.rows[0].id, userId };
  });
}

describe("requireMatterAccess — wired the same way as index.ts, across every :matterId-scoped router", () => {
  let orgIdsToClean: string[] = [];

  afterEach(async () => {
    for (const id of orgIdsToClean) await cleanupTestOrg(id);
    orgIdsToClean = [];
  });

  it("403s a non-admin, non-member user; 200s once granted; 403s again immediately after removal — no other mechanism needed", async () => {
    const { orgId, matterId, userId } = await createTestOrgMatterAndUser("access-enforcement");
    orgIdsToClean.push(orgId);
    const app = buildTestApp({ orgId, userId, role: "reviewer", email: "tester@example.com" });

    // Not a member yet (createTestOrgMatterAndUser doesn't auto-add — that's
    // matters.ts POST /'s own job, deliberately bypassed here to test the
    // gate itself in isolation).
    expect((await request(app).get(`/api/matters/${matterId}/documents`)).status).toBe(403);
    expect((await request(app).get(`/api/matters/${matterId}/tags`)).status).toBe(403);
    expect((await request(app).get(`/api/matters/${matterId}/document-tags`)).status).toBe(403);
    // exports has no plain GET / — a nonexistent exportId still proves the
    // gate itself denies first (403), distinct from the router's own 404.
    expect((await request(app).get(`/api/matters/${matterId}/exports/${randomUUID()}`)).status).toBe(403);

    await withOrgSession(orgId, (client) =>
      client.query("INSERT INTO matter_members (matter_id, user_id, org_id) VALUES ($1, $2, $3)", [matterId, userId, orgId]),
    );

    expect((await request(app).get(`/api/matters/${matterId}/documents`)).status).toBe(200);
    expect((await request(app).get(`/api/matters/${matterId}/tags`)).status).toBe(200);
    expect((await request(app).get(`/api/matters/${matterId}/document-tags`)).status).toBe(200);
    // Now reaches exportsRouter's own logic, which legitimately 404s on a
    // fake id — proves access was granted, not that the export happens to exist.
    expect((await request(app).get(`/api/matters/${matterId}/exports/${randomUUID()}`)).status).toBe(404);

    await withOrgSession(orgId, (client) => client.query("DELETE FROM matter_members WHERE matter_id = $1 AND user_id = $2", [matterId, userId]));

    // The very next request is rejected — no session/push mechanism, just a
    // fresh check every time.
    expect((await request(app).get(`/api/matters/${matterId}/documents`)).status).toBe(403);
  });

  it("admin bypasses matter_members entirely — never needs a row there", async () => {
    const { orgId, matterId, userId } = await createTestOrgMatterAndUser("access-enforcement-admin");
    orgIdsToClean.push(orgId);
    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });

    const noMembership = await withOrgSession(orgId, (client) =>
      client.query("SELECT 1 FROM matter_members WHERE matter_id = $1 AND user_id = $2", [matterId, userId]),
    );
    expect(noMembership.rowCount).toBe(0);

    expect((await request(app).get(`/api/matters/${matterId}/documents`)).status).toBe(200);
  });
});

// resolveOrgContext is the one function every other test file in this
// codebase deliberately bypasses (they all inject eddContext directly,
// same as buildTestApp above) — this is its own, first direct test,
// exercising the real function against a mocked req.auth.payload (the
// shape express-oauth2-jwt-bearer's own requireValidToken would populate
// from a real, already-verified JWT — not re-tested here, that's the
// library's job, not this app's) and a mocked getOrganizationMemberContext
// (Auth0 is the sole source of truth for org/role now — no DB round trip
// left in this function at all).
function buildResolveOrgContextApp(payload: { sub?: string; org_id?: string }) {
  const app = express();
  app.use((req, _res, next) => {
    req.auth = { payload } as unknown as express.Request["auth"];
    next();
  });
  app.use(resolveOrgContext);
  app.get("/whoami", (req, res) => res.json(req.eddContext));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

describe("resolveOrgContext", () => {
  beforeEach(() => {
    vi.mocked(getOrganizationMemberContext).mockReset();
  });

  it("resolves userId/orgId straight from the token, and role/email from Auth0", async () => {
    const auth0UserId = `auth0|${randomUUID()}`;
    const auth0OrgId = "org_realtenant123";
    vi.mocked(getOrganizationMemberContext).mockResolvedValue({ role: "reviewer", email: "member@example.com", name: null });

    const app = buildResolveOrgContextApp({ sub: auth0UserId, org_id: auth0OrgId });
    const response = await request(app).get("/whoami").send();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: auth0UserId, orgId: auth0OrgId, role: "reviewer", email: "member@example.com" });
    expect(getOrganizationMemberContext).toHaveBeenCalledWith(auth0OrgId, auth0UserId);
  });

  it("403s when the token has no org_id claim at all — nothing local left to fall back to", async () => {
    const app = buildResolveOrgContextApp({ sub: `auth0|${randomUUID()}` });
    const response = await request(app).get("/whoami").send();
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/log in through your organization/i);
    expect(getOrganizationMemberContext).not.toHaveBeenCalled();
  });

  it("403s when Auth0 reports no recognized role for this user in this org", async () => {
    vi.mocked(getOrganizationMemberContext).mockResolvedValue(null);
    const app = buildResolveOrgContextApp({ sub: `auth0|${randomUUID()}`, org_id: "org_realtenant123" });
    const response = await request(app).get("/whoami").send();
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/not a member/i);
  });

  it("401s when the token is missing the sub claim", async () => {
    const app = buildResolveOrgContextApp({ org_id: "org_realtenant123" });
    const response = await request(app).get("/whoami").send();
    expect(response.status).toBe(401);
  });
});

afterAll(async () => {
  await pool.end();
});
