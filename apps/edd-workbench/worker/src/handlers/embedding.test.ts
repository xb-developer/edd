import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withOrgSession, initMatterGuidCounter } from "@xbundle/edd-workbench-core";
import { handleEmbeddingMessage } from "./embedding.js";

async function deleteTestOrg(orgId: string): Promise<void> {
  // Doesn't also clean up ai_usage: that table is increment-only (no
  // DELETE grant for the app role — see migration 028), but each test uses
  // its own fresh random org_id and RLS scopes every query to it, so a
  // leftover row from a previous run is simply invisible to (and harmless
  // for) the next one.
  await withOrgSession(orgId, (client) => client.query("DELETE FROM matters WHERE org_id = $1", [orgId]));
}

async function createTestDocument(params: {
  contentType: string;
  metadata: Record<string, unknown> | null;
  uploadedBy?: string;
}): Promise<{ orgId: string; matterId: string; documentId: string; uploadedBy: string }> {
  const orgId = `org_test_${randomUUID()}`;
  const uploadedBy = params.uploadedBy ?? `auth0|${randomUUID()}`;

  return withOrgSession(orgId, async (client) => {
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
      orgId,
      "embedding handler test matter",
    ]);
    const matterId = matterRow.rows[0].id;
    await initMatterGuidCounter(client, matterId);

    const documentId = randomUUID();
    await client.query(
      `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status, metadata, uploaded_by)
       VALUES ($1, $2, $3, NULL, $1, 0, 1, 'doc.eml', 'eml', 100, 'tenants/test/x/original.eml', $4, 'ready', $5, $6)`,
      [documentId, orgId, matterId, params.contentType, params.metadata !== null ? JSON.stringify(params.metadata) : null, uploadedBy],
    );
    return { orgId, matterId, documentId, uploadedBy };
  });
}

async function getAiUsage(orgId: string): Promise<{ user_id: string; call_site: string; total_tokens: string }[]> {
  const rows = await withOrgSession(orgId, (client) =>
    client.query("SELECT user_id, call_site, total_tokens FROM ai_usage WHERE org_id = $1", [orgId]),
  );
  return rows.rows;
}

async function getDocument(orgId: string, documentId: string) {
  const row = await withOrgSession(orgId, (client) => client.query("SELECT * FROM documents WHERE id = $1", [documentId]));
  return row.rows[0];
}

async function getChunks(orgId: string, documentId: string) {
  const rows = await withOrgSession(orgId, (client) =>
    client.query("SELECT chunk_index, text FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index", [documentId]),
  );
  return rows.rows;
}

describe("handleEmbeddingMessage", () => {
  let cleanupOrgId: string | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.EMBEDDING_SERVICE_URL;
    if (cleanupOrgId) await deleteTestOrg(cleanupOrgId);
    cleanupOrgId = null;
  });

  it("chunks, embeds, stores the chunks, and marks embedding_status ready", async () => {
    const { orgId, documentId } = await createTestDocument({ contentType: "eml", metadata: { bodyText: "hello world" } });
    cleanupOrgId = orgId;

    process.env.EMBEDDING_SERVICE_URL = "http://embedding.internal:8000";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ index: 0, embedding: Array(1024).fill(0.5) }], usage: { total_tokens: 3 } }),
      }),
    );

    await handleEmbeddingMessage(JSON.stringify({ documentId, orgId }));

    const doc = await getDocument(orgId, documentId);
    expect(doc.embedding_status).toBe("ready");
    expect(doc.embedding_error).toBeNull();

    const chunks = await getChunks(orgId, documentId);
    expect(chunks).toEqual([{ chunk_index: 0, text: "hello world" }]);
  });

  it("records the embedding call's token usage against the document's uploader", async () => {
    const { orgId, documentId, uploadedBy } = await createTestDocument({ contentType: "eml", metadata: { bodyText: "hello world" } });
    cleanupOrgId = orgId;

    process.env.EMBEDDING_SERVICE_URL = "http://embedding.internal:8000";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ index: 0, embedding: Array(1024).fill(0.5) }], usage: { total_tokens: 7 } }),
      }),
    );

    await handleEmbeddingMessage(JSON.stringify({ documentId, orgId }));

    expect(await getAiUsage(orgId)).toEqual([{ user_id: uploadedBy, call_site: "embedding", total_tokens: "7" }]);
  });

  it("marks embedding_status excluded, without ever calling the embedding service, for an ineligible content type", async () => {
    const { orgId, documentId } = await createTestDocument({ contentType: "xlsx", metadata: { sheets: [] } });
    cleanupOrgId = orgId;

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await handleEmbeddingMessage(JSON.stringify({ documentId, orgId }));

    const doc = await getDocument(orgId, documentId);
    expect(doc.embedding_status).toBe("excluded");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("marks embedding_status excluded for a document with no real text at all", async () => {
    const { orgId, documentId } = await createTestDocument({ contentType: "other", metadata: null });
    cleanupOrgId = orgId;

    await handleEmbeddingMessage(JSON.stringify({ documentId, orgId }));

    const doc = await getDocument(orgId, documentId);
    expect(doc.embedding_status).toBe("excluded");
  });

  it("marks embedding_status failed, with the error recorded, when the embedding service call fails", async () => {
    const { orgId, documentId } = await createTestDocument({ contentType: "eml", metadata: { bodyText: "hello world" } });
    cleanupOrgId = orgId;

    process.env.EMBEDDING_SERVICE_URL = "http://embedding.internal:8000";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "model not loaded" }));

    await handleEmbeddingMessage(JSON.stringify({ documentId, orgId }));

    const doc = await getDocument(orgId, documentId);
    expect(doc.embedding_status).toBe("failed");
    expect(doc.embedding_error).toContain("model not loaded");

    const chunks = await getChunks(orgId, documentId);
    expect(chunks).toEqual([]);
  });

  it("does nothing (not an error) when the document has already been deleted", async () => {
    const { orgId, documentId } = await createTestDocument({ contentType: "eml", metadata: { bodyText: "hello" } });
    await deleteTestOrg(orgId); // gone before the handler ever runs

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(handleEmbeddingMessage(JSON.stringify({ documentId, orgId }))).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
