import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { recordAiUsage } from "@xbundle/edd-workbench-core";
import { aiUsageRouter } from "./aiUsage.js";
import type { EddRequestContext } from "../auth.js";

// Same test-only middleware pattern workerStatus.test.ts/ask.test.ts use —
// the real requireValidToken/resolveOrgContext chain needs a genuine Auth0
// JWT, which has no local substitute in this project.
function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/ai-usage", aiUsageRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

function context(orgId: string, userId: string): EddRequestContext {
  return { orgId, userId, role: "reviewer", email: "test@example.com" };
}

describe("aiUsageRouter", () => {
  it("returns all-zero totals for a caller with no recorded usage yet", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;

    const res = await request(buildTestApp(context(orgId, userId))).get("/api/ai-usage/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ embedding: 0, ask: 0, summarization: 0, total: 0 });
  });

  it("returns the caller's own breakdown and total, never another user's usage in the same org", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;
    const otherUserId = `auth0|${randomUUID()}`;

    await recordAiUsage(orgId, userId, "embedding", 100);
    await recordAiUsage(orgId, userId, "ask", 10);
    await recordAiUsage(orgId, userId, "summarization", 20);
    await recordAiUsage(orgId, otherUserId, "ask", 999);

    const res = await request(buildTestApp(context(orgId, userId))).get("/api/ai-usage/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ embedding: 100, ask: 10, summarization: 20, total: 130 });
  });
});
