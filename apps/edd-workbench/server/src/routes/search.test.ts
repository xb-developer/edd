import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EddRequestContext } from "../auth.js";
import { searchRouter } from "./search.js";

function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/matters/:matterId/search", searchRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

describe("searchRouter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ELASTICSEARCH_SERVICE_URL;
  });

  it("returns an empty result without calling Elasticsearch for a blank/missing query", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const matterId = randomUUID();
    const app = buildTestApp({ orgId: `org_${randomUUID()}`, userId: `auth0|${randomUUID()}`, role: "reviewer", email: "t@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/search`).query({ q: "   " });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ documentIds: [], totalHits: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("queries Elasticsearch scoped to the matter and returns its documentIds/totalHits", async () => {
    process.env.ELASTICSEARCH_SERVICE_URL = "http://search.internal:9200";
    const orgId = `org_${randomUUID()}`;
    const matterId = randomUUID();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hits: { total: { value: 2 }, hits: [{ _id: "doc-1" }, { _id: "doc-2" }] } }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const app = buildTestApp({ orgId, userId: `auth0|${randomUUID()}`, role: "reviewer", email: "t@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/search`).query({ q: "invoice" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ documentIds: ["doc-1", "doc-2"], totalHits: 2 });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.query.bool.filter).toEqual([{ term: { org_id: orgId } }, { term: { matter_id: matterId } }]);
  });

  it("503s with a clear message when Elasticsearch is unreachable", async () => {
    process.env.ELASTICSEARCH_SERVICE_URL = "http://search.internal:9200";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "no healthy upstream" }));

    const matterId = randomUUID();
    const app = buildTestApp({ orgId: `org_${randomUUID()}`, userId: `auth0|${randomUUID()}`, role: "reviewer", email: "t@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/search`).query({ q: "invoice" });

    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/temporarily unavailable/i);
  });
});
