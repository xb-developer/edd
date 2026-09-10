import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { withOrgSession, recordAuditEvent } from "@xbundle/edd-workbench-core";
import { auditRouter } from "./audit.js";
import type { EddRequestContext } from "../auth.js";

// Same test-only middleware pattern aiUsage.test.ts/workerStatus.test.ts
// use — the real requireValidToken/resolveOrgContext chain needs a genuine
// Auth0 JWT, which has no local substitute in this project.
function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/audit", auditRouter);
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

// No cleanup here (unlike most other route test files' deleteTestOrg
// pattern) — audit_log is deliberately append-only (see migration 023's
// own comment: "no UPDATE/DELETE grant at all" for edd_workbench_app), and
// each test below uses its own fresh random orgId, so leftover rows from
// one test run never affect another's assertions.
describe("auditRouter", () => {
  it("GET /export is forbidden for a non-admin role", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const res = await request(buildTestApp(context(orgId, `auth0|${randomUUID()}`, "reviewer"))).get("/api/audit/export");
    expect(res.status).toBe(403);
  });

  it("GET /export returns a CSV of this org's audit events, chronologically, excluding other orgs", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const otherOrgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;

    // matter_id left null (rather than a fabricated id) — audit_log.matter_id
    // is a real FK to matters(id), only nulled out on the matter's own
    // later deletion (ON DELETE SET NULL), not something a fresh insert can
    // point at a nonexistent row.
    await withOrgSession(orgId, (client) =>
      recordAuditEvent(client, { orgId, actorUserId: userId, action: "matter.create", description: 'Created matter "Alpha"' }),
    );
    await withOrgSession(orgId, (client) =>
      recordAuditEvent(client, { orgId, actorUserId: userId, action: "matter.delete", description: 'Deleted matter "Alpha"' }),
    );
    await withOrgSession(otherOrgId, (client) =>
      recordAuditEvent(client, { orgId: otherOrgId, actorUserId: userId, action: "logout", description: "Should not appear" }),
    );

    const res = await request(buildTestApp(context(orgId, userId))).get("/api/audit/export");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);

    const lines = res.text.trim().split("\n");
    expect(lines[0]).toBe("timestamp,action,description,actor_user_id,matter_id,document_id,details");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("matter.create");
    expect(lines[1]).toContain('Created matter ""Alpha""'); // csv-stringify escapes an embedded " by doubling it
    expect(lines[2]).toContain("matter.delete");
    expect(res.text).not.toContain("Should not appear");
  });
});
