import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EddRequestContext } from "../auth.js";
import { searchHealthRouter } from "./searchHealth.js";

function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/search-health", searchHealthRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

function context(orgId: string, role: EddRequestContext["role"]): EddRequestContext {
  return { orgId, userId: `auth0|${randomUUID()}`, role, email: "test@example.com" };
}

describe("searchHealthRouter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ELASTICSEARCH_SERVICE_URL;
  });

  it("returns the calling user's own org's ES doc count alongside its Postgres ready/failed count, for a non-admin caller too", async () => {
    process.env.ELASTICSEARCH_SERVICE_URL = "http://search.internal:9200";
    const orgId = `org_${randomUUID()}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 7 }) }));

    const app = buildTestApp(context(orgId, "reviewer"));
    const res = await request(app).get("/api/search-health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ esDocCount: 7, postgresDocCount: 0 });
  });

  it("returns the calling admin's own org's ES doc count alongside its Postgres ready/failed count", async () => {
    process.env.ELASTICSEARCH_SERVICE_URL = "http://search.internal:9200";
    const orgId = `org_${randomUUID()}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 7 }) }));

    const app = buildTestApp(context(orgId, "admin"));
    const res = await request(app).get("/api/search-health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ esDocCount: 7, postgresDocCount: 0 });
  });
});
