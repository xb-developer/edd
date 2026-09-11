import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { withOrgSession } from "@xbundle/edd-workbench-core";
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
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

function context(orgId: string, userId: string): EddRequestContext {
  return { orgId, userId, role: "reviewer", email: "test@example.com" };
}

describe("auditRouter", () => {
  it("POST /logout records a logout event and returns 204", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;

    const res = await request(buildTestApp(context(orgId, userId))).post("/api/audit/logout");
    expect(res.status).toBe(204);

    const rows = await withOrgSession(orgId, (client) =>
      client.query("SELECT action, description, actor_user_id FROM audit_log WHERE org_id = $1", [orgId]),
    );
    expect(rows.rows).toEqual([{ action: "logout", description: "User logged out", actor_user_id: userId }]);
  });
});
