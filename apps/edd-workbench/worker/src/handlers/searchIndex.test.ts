import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withOrgSession, initMatterGuidCounter } from "@xbundle/edd-workbench-core";
import { handleSearchIndexMessage } from "./searchIndex.js";

async function deleteTestOrg(orgId: string): Promise<void> {
  await withOrgSession(orgId, (client) => client.query("DELETE FROM matters WHERE org_id = $1", [orgId]));
}

async function createTestDocument(params: {
  contentType: string;
  metadata: Record<string, unknown> | null;
}): Promise<{ orgId: string; matterId: string; documentId: string }> {
  const orgId = `org_test_${randomUUID()}`;

  return withOrgSession(orgId, async (client) => {
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
      orgId,
      "search-index handler test matter",
    ]);
    const matterId = matterRow.rows[0].id;
    await initMatterGuidCounter(client, matterId);

    const documentId = randomUUID();
    await client.query(
      `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status, metadata)
       VALUES ($1, $2, $3, NULL, $1, 0, 1, 'doc.eml', 'eml', 100, 'tenants/test/x/original.eml', $4, 'ready', $5)`,
      [documentId, orgId, matterId, params.contentType, params.metadata !== null ? JSON.stringify(params.metadata) : null],
    );
    return { orgId, matterId, documentId };
  });
}

describe("handleSearchIndexMessage", () => {
  let cleanupOrgId: string | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.ELASTICSEARCH_SERVICE_URL;
    if (cleanupOrgId) await deleteTestOrg(cleanupOrgId);
    cleanupOrgId = null;
  });

  it("indexes a document's resolved text, filename, and guid", async () => {
    const { orgId, matterId, documentId } = await createTestDocument({ contentType: "eml", metadata: { bodyText: "hello world" } });
    cleanupOrgId = orgId;

    process.env.ELASTICSEARCH_SERVICE_URL = "http://search.internal:9200";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    await handleSearchIndexMessage(JSON.stringify({ documentId, orgId }));

    expect(fetchSpy).toHaveBeenCalledWith(
      `http://search.internal:9200/edd-workbench-documents/_doc/${documentId}`,
      expect.objectContaining({ method: "PUT" }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({ org_id: orgId, matter_id: matterId, filename: "doc.eml", extension: "eml", guid: "000001", body: "hello world" });
  });

  it("still indexes a document with no resolvable text, with an empty body — not skipped, since it must stay filename-searchable", async () => {
    const { orgId, documentId } = await createTestDocument({ contentType: "xlsx", metadata: { sheets: [] } });
    cleanupOrgId = orgId;

    process.env.ELASTICSEARCH_SERVICE_URL = "http://search.internal:9200";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    await handleSearchIndexMessage(JSON.stringify({ documentId, orgId }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.body).toBe("");
    expect(body.filename).toBe("doc.eml");
  });

  it("does nothing (not an error) when the document has already been deleted", async () => {
    const { orgId, documentId } = await createTestDocument({ contentType: "eml", metadata: { bodyText: "hello" } });
    await deleteTestOrg(orgId); // gone before the handler ever runs

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(handleSearchIndexMessage(JSON.stringify({ documentId, orgId }))).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
