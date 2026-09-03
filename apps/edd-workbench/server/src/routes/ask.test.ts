import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool, withOrgSession, initMatterGuidCounter, replaceDocumentChunks } from "@xbundle/edd-workbench-core";
import type { EddRequestContext } from "../auth.js";
import { askRouter } from "./ask.js";

function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/matters/:matterId/ask", askRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

async function cleanupTestOrg(orgId: string): Promise<void> {
  // Doesn't also clean up ai_usage: that table is increment-only (no
  // DELETE grant for the app role — see migration 028), but each test uses
  // its own fresh random org_id and RLS scopes every query to it, so a
  // leftover row from a previous run is simply invisible to (and harmless
  // for) the next one.
  await withOrgSession(orgId, (client) => client.query("DELETE FROM matters WHERE org_id = $1", [orgId]));
}

async function getAiUsage(orgId: string): Promise<{ user_id: string; call_site: string; total_tokens: string }[]> {
  const rows = await withOrgSession(orgId, (client) =>
    client.query("SELECT user_id, call_site, total_tokens FROM ai_usage WHERE org_id = $1 ORDER BY call_site", [orgId]),
  );
  return rows.rows;
}

// A 1024-dim one-hot vector — cosine distance between two one-hot vectors
// is 0 (identical index) or 1 (different index, orthogonal), which makes
// the MAX_COSINE_DISTANCE cutoff trivially exact to test against without
// needing real embedding math.
function oneHot(index: number): number[] {
  const v = new Array(1024).fill(0);
  v[index] = 1;
  return v;
}

async function createDocumentWithChunk(orgId: string, matterId: string, guidNumber: number, filename: string, embedding: number[]) {
  return withOrgSession(orgId, async (client) => {
    const documentId = randomUUID();
    await client.query(
      `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
       VALUES ($1, $2, $3, NULL, $1, 0, $4, $5, 'txt', 100, 'tenants/test/x/original.txt', 'text', 'ready')`,
      [documentId, orgId, matterId, guidNumber, filename],
    );
    await replaceDocumentChunks(client, { orgId, matterId, documentId, chunks: [{ text: "chunk text", embedding }] });
    return documentId;
  });
}

async function createTestMatter(orgId: string, name: string): Promise<string> {
  return withOrgSession(orgId, async (client) => {
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [orgId, name]);
    await initMatterGuidCounter(client, matterRow.rows[0].id);
    return matterRow.rows[0].id;
  });
}

function stubGpuFetch(chatContent = "This is a grounded answer.") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/v1/embeddings")) {
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: oneHot(0), index: 0 }], usage: { total_tokens: 5 } }),
        } as Response;
      }
      if (url.includes("/v1/chat/completions")) {
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: chatContent } }], usage: { total_tokens: 30 } }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

describe("askRouter", () => {
  let orgIdsToClean: string[] = [];

  beforeEach(() => {
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.internal:8000";
    process.env.GENERATION_SERVICE_URL = "http://generation.internal:8000";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const id of orgIdsToClean) await cleanupTestOrg(id);
    orgIdsToClean = [];
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns only the matching, same-matter document — filters both by cosine distance and matter_id", async () => {
    const orgId = `org_test_${randomUUID()}`;
    orgIdsToClean.push(orgId);
    const matterId = await createTestMatter(orgId, "ask-scoping test matter");
    const otherMatterId = await createTestMatter(orgId, "ask-scoping other matter");

    const relevantDocId = await createDocumentWithChunk(orgId, matterId, 1, "relevant.txt", oneHot(0));
    await createDocumentWithChunk(orgId, matterId, 2, "irrelevant.txt", oneHot(1));
    // Identical embedding to the relevant chunk, but in a different matter
    // — must never come back, proving matter_id (not just org_id) scopes
    // this query.
    await createDocumentWithChunk(orgId, otherMatterId, 1, "same-org-other-matter.txt", oneHot(0));

    stubGpuFetch();
    const app = buildTestApp({ orgId, userId: `auth0|${randomUUID()}`, role: "reviewer", email: "tester@example.com" });
    const response = await request(app).post(`/api/matters/${matterId}/ask`).send({ question: "What happened?" });

    expect(response.status).toBe(200);
    expect(response.body.answer).toBe("This is a grounded answer.");
    expect(response.body.relevantDocuments).toEqual([{ documentId: relevantDocId, guid: "000001", filename: "relevant.txt" }]);
  });

  it("records the ask (question-embedding) and summarization (answer-generation) token usage against the caller", async () => {
    const orgId = `org_test_${randomUUID()}`;
    orgIdsToClean.push(orgId);
    const matterId = await createTestMatter(orgId, "ask-usage test matter");
    await createDocumentWithChunk(orgId, matterId, 1, "relevant.txt", oneHot(0));

    stubGpuFetch();
    const userId = `auth0|${randomUUID()}`;
    const app = buildTestApp({ orgId, userId, role: "reviewer", email: "tester@example.com" });
    const response = await request(app).post(`/api/matters/${matterId}/ask`).send({ question: "What happened?" });

    expect(response.status).toBe(200);
    expect(await getAiUsage(orgId)).toEqual([
      { user_id: userId, call_site: "ask", total_tokens: "5" },
      { user_id: userId, call_site: "summarization", total_tokens: "30" },
    ]);
  });

  it("returns a fixed no-results answer, without calling generation, when nothing is close enough", async () => {
    const orgId = `org_test_${randomUUID()}`;
    orgIdsToClean.push(orgId);
    const matterId = await createTestMatter(orgId, "ask-no-results test matter");
    await createDocumentWithChunk(orgId, matterId, 1, "unrelated.txt", oneHot(1));

    stubGpuFetch();
    const app = buildTestApp({ orgId, userId: `auth0|${randomUUID()}`, role: "reviewer", email: "tester@example.com" });
    const response = await request(app).post(`/api/matters/${matterId}/ask`).send({ question: "What happened?" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ answer: "No relevant documents found for this question.", relevantDocuments: [] });
    expect(vi.mocked(fetch).mock.calls.some((call) => String(call[0]).includes("/v1/chat/completions"))).toBe(false);
  });

  it("400s an empty question", async () => {
    const orgId = `org_test_${randomUUID()}`;
    orgIdsToClean.push(orgId);
    const matterId = await createTestMatter(orgId, "ask-empty-question test matter");

    const app = buildTestApp({ orgId, userId: `auth0|${randomUUID()}`, role: "reviewer", email: "tester@example.com" });
    const response = await request(app).post(`/api/matters/${matterId}/ask`).send({ question: "   " });

    expect(response.status).toBe(400);
  });

  it("503s with a clear message when the GPU service is unreachable", async () => {
    const orgId = `org_test_${randomUUID()}`;
    orgIdsToClean.push(orgId);
    const matterId = await createTestMatter(orgId, "ask-gpu-down test matter");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, text: async () => "no healthy upstream" }) as Response),
    );
    const app = buildTestApp({ orgId, userId: `auth0|${randomUUID()}`, role: "reviewer", email: "tester@example.com" });
    const response = await request(app).post(`/api/matters/${matterId}/ask`).send({ question: "What happened?" });

    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/business hours|7am|19:00/i);
  });
});
