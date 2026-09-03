import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(body.query.bool.filter).toEqual([{ term: { org_id: "org-1" } }, { term: { matter_id: "matter-1" } }]);
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
    expect(body).toEqual({ query: { term: { org_id: "org-1" } } });
  });
});
