import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { withOrgSession, recordAuditEvent } from "@xbundle/edd-workbench-core";
import { matterAuditRouter } from "./matterAudit.js";
import type { EddRequestContext } from "../auth.js";

// Same test-only middleware pattern tags.test.ts/documents.test.ts use —
// the real requireValidToken/resolveOrgContext/requireMatterAccess chain
// needs a genuine Auth0 JWT, which has no local substitute in this project.
function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/matters/:matterId/audit", matterAuditRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (typeof status === "number") {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

function context(orgId: string, userId: string, role: EddRequestContext["role"] = "admin"): EddRequestContext {
  return { orgId, userId, role, email: "test@example.com" };
}

// No tag_sets/tags seeding needed here (unlike tags.test.ts's own helper)
// — audit doesn't touch either. deleteTestOrg deliberately doesn't touch
// audit_log (the app role has no DELETE grant on it — see migration 023's
// "no UPDATE/DELETE grant at all"); each test uses its own fresh random
// orgId, so leftover rows never affect another test's assertions.
async function createTestOrgAndMatter(namePrefix: string) {
  const orgId = `org_test_${randomUUID()}`;
  const userId = `auth0|${randomUUID()}`;
  return withOrgSession(orgId, async (client) => {
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
      orgId,
      `${namePrefix} test matter`,
    ]);
    return { orgId, matterId: matterRow.rows[0].id, userId };
  });
}

async function deleteTestOrg(orgId: string): Promise<void> {
  await withOrgSession(orgId, (client) => client.query("DELETE FROM matters WHERE org_id = $1", [orgId]));
}

describe("matterAuditRouter", () => {
  it("POST / records a matter.load event naming the matter", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("audit-load");
    try {
      const res = await request(buildTestApp(context(orgId, userId, "reviewer"))).post(`/api/matters/${matterId}/audit`);
      expect(res.status).toBe(204);

      const rows = await withOrgSession(orgId, (client) =>
        client.query("SELECT action, description, matter_id, actor_user_id FROM audit_log WHERE matter_id = $1", [matterId]),
      );
      expect(rows.rows).toEqual([
        { action: "matter.load", description: 'Loaded matter "audit-load test matter"', matter_id: matterId, actor_user_id: userId },
      ]);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("GET /export is forbidden for a non-admin role", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("audit-export-forbidden");
    try {
      const res = await request(buildTestApp(context(orgId, userId, "reviewer"))).get(`/api/matters/${matterId}/audit/export`);
      expect(res.status).toBe(403);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("GET /export returns a CSV of only this matter's audit events, chronologically, excluding another matter in the same org", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("audit-export-a");
    // A second matter in the SAME org (not a fresh org via
    // createTestOrgAndMatter) — the isolation this test cares about is
    // matter_id filtering, which org-level RLS alone wouldn't exercise.
    const otherMatterId = await withOrgSession(orgId, async (client) => {
      const row = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
        orgId,
        "audit-export-b test matter",
      ]);
      return row.rows[0].id;
    });
    try {
      await withOrgSession(orgId, (client) =>
        recordAuditEvent(client, { orgId, actorUserId: userId, matterId, action: "matter.load", description: 'Loaded matter "Alpha"' }),
      );
      await withOrgSession(orgId, (client) =>
        recordAuditEvent(client, { orgId, actorUserId: userId, matterId, action: "matter.delete", description: 'Deleted matter "Alpha"' }),
      );
      await withOrgSession(orgId, (client) =>
        recordAuditEvent(client, {
          orgId,
          actorUserId: userId,
          matterId: otherMatterId,
          action: "matter.load",
          description: "Should not appear — a different matter",
        }),
      );

      const res = await request(buildTestApp(context(orgId, userId))).get(`/api/matters/${matterId}/audit/export`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/csv/);
      expect(res.headers["content-disposition"]).toMatch(new RegExp(`^attachment; filename="audit-log-${matterId}-\\d{4}-\\d{2}-\\d{2}\\.csv"$`));

      const lines = res.text.trim().split("\n");
      expect(lines[0]).toBe("timestamp,action,description,actor_user_id,document_id,details");
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain("matter.load");
      expect(lines[1]).toContain('Loaded matter ""Alpha""'); // csv-stringify escapes an embedded " by doubling it
      expect(lines[2]).toContain("matter.delete");
      expect(res.text).not.toContain("Should not appear");
    } finally {
      await deleteTestOrg(orgId);
    }
  });
});
