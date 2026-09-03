import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexDocument, deleteDocumentFromIndex, searchDocuments, getIndexHealth } from "./searchClient.js";

const DOC = {
  documentId: "doc-1",
  orgId: "org-1",
  matterId: "matter-1",
  filename: "invoice.pdf",
  extension: "pdf",
  guid: "000001",
  body: "some extracted text",
};

describe("searchClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ELASTICSEARCH_SERVICE_URL;
  });

  it("throws if ELASTICSEARCH_SERVICE_URL isn't set, without ever calling fetch", async () => {
    // vitest.config.ts sets a real default for every other test in this
    // suite (a genuine local Elasticsearch, not mocked) — unset it just for
    // this one test, which is specifically about the missing-env-var case.
    delete process.env.ELASTICSEARCH_SERVICE_URL;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(indexDocument(DOC)).rejects.toThrow("ELASTICSEARCH_SERVICE_URL");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("indexDocument PUTs to /_doc/{documentId} with the mapped field names", async () => {
    process.env.ELASTICSEARCH_SERVICE_URL = "http://es.internal:9200";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    await indexDocument(DOC);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://es.internal:9200/edd-workbench-documents/_doc/doc-1",
      expect.objectContaining({ method: "PUT" }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({
      org_id: "org-1",
      matter_id: "matter-1",
      filename: "invoice.pdf",
      extension: "pdf",
      guid: "000001",
      body: "some extracted text",
    });
  });

  it("deleteDocumentFromIndex treats a 404 as success", async () => {
    process.env.ELASTICSEARCH_SERVICE_URL = "http://es.internal:9200";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(deleteDocumentFromIndex("doc-1")).resolves.toBeUndefined();
  });

  it("deleteDocumentFromIndex throws on a real failure", async () => {
    process.env.ELASTICSEARCH_SERVICE_URL = "http://es.internal:9200";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "unavailable" }));

    await expect(deleteDocumentFromIndex("doc-1")).rejects.toThrow("unavailable");
  });

  it("searchDocuments filters by org_id and matter_id, uses simple_query_string with default_operator OR, and returns documentIds plus totalHits", async () => {
    process.env.ELASTICSEARCH_SERVICE_URL = "http://es.internal:9200";
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hits: { total: { value: 42 }, hits: [{ _id: "doc-1" }, { _id: "doc-2" }] } }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await searchDocuments("org-1", "matter-1", "invoice payment");

    expect(result).toEqual({ documentIds: ["doc-1", "doc-2"], totalHits: 42 });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.query.bool.filter).toEqual([
      { term: { "org_id.keyword": "org-1" } },
      { term: { "matter_id.keyword": "matter-1" } },
    ]);
    expect(body.query.bool.must[0].simple_query_string).toEqual({
      query: "invoice payment",
      fields: ["body", "filename"],
      default_operator: "OR",
    });
    expect(body.track_total_hits).toBe(true);
  });

  it("searchDocuments throws with the response body when the request fails", async () => {
    process.env.ELASTICSEARCH_SERVICE_URL = "http://es.internal:9200";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "index not ready" }));

    await expect(searchDocuments("org-1", "matter-1", "x")).rejects.toThrow("index not ready");
  });

  it("getIndexHealth returns one org's document count, filtered by org_id", async () => {
    process.env.ELASTICSEARCH_SERVICE_URL = "http://es.internal:9200";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 1234 }) });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(getIndexHealth("org-1")).resolves.toEqual({ docCount: 1234 });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({ query: { term: { "org_id.keyword": "org-1" } } });
  });
});

// Real Elasticsearch, no mocking (vitest.config.ts's own default
// ELASTICSEARCH_SERVICE_URL, not overridden here) — this is the round trip
// the mocked tests above cannot verify: that indexing a document and then
// searching for it by org/matter actually finds it against a REAL cluster
// with REAL dynamic field mapping. Realistic org_id ("org_" + random hex,
// underscore) and matter_id (a real UUID, hyphens) deliberately, not
// "org-1"/"matter-1" — those plain mocked-test ids happen to tokenize as a
// single word under the standard analyzer, which would have silently
// hidden the exact bug this suite exists to catch (a `term` filter on the
// bare, analyzed field name never matches org/matter ids shaped like
// production's real ones).
describe("searchClient (real Elasticsearch)", () => {
  // The sibling describe above deletes ELASTICSEARCH_SERVICE_URL in its own
  // afterEach (each of its tests re-sets its own mocked value, so it's
  // self-healing there) — restore vitest.config.ts's real default here too,
  // since this describe relies on it and runs after that one in file order.
  beforeEach(() => {
    process.env.ELASTICSEARCH_SERVICE_URL = "http://localhost:9200";
  });

  it("finds a real indexed document via searchDocuments, scoped to its real org_id/matter_id", async () => {
    const orgId = `org_${randomUUID().replace(/-/g, "")}`;
    const matterId = randomUUID();
    const documentId = randomUUID();

    await indexDocument({
      documentId,
      orgId,
      matterId,
      filename: "real-es-roundtrip.pdf",
      extension: "pdf",
      guid: "000001",
      body: "a genuinely unique searchable phrase zzqxvroundtrip",
    });
    try {
      // Newly indexed docs aren't visible to _search until the next refresh
      // cycle (unlike a GET by _id, which is realtime) — force it rather
      // than racing the default ~1s interval.
      await fetch(`${process.env.ELASTICSEARCH_SERVICE_URL}/edd-workbench-documents/_refresh`, { method: "POST" });

      const result = await searchDocuments(orgId, matterId, "zzqxvroundtrip");
      expect(result.documentIds).toEqual([documentId]);
      expect(result.totalHits).toBe(1);

      // A different, real matter_id must never see another matter's
      // document — the whole point of scoping the filter at all.
      const otherMatter = await searchDocuments(orgId, randomUUID(), "zzqxvroundtrip");
      expect(otherMatter.documentIds).toEqual([]);
    } finally {
      await deleteDocumentFromIndex(documentId);
    }
  });
});
