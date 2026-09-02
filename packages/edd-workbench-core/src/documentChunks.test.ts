import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withOrgSession } from "./session.js";
import { initMatterGuidCounter } from "./guidCounter.js";
import { replaceDocumentChunks } from "./documentChunks.js";

async function deleteTestOrg(orgId: string): Promise<void> {
  await withOrgSession(orgId, (client) => client.query("DELETE FROM matters WHERE org_id = $1", [orgId]));
}

// document_chunks.embedding is a fixed vector(1024) column (see migration
// 026) — every test embedding must be exactly that length, not a toy
// 1-3 element array, or Postgres itself correctly rejects the insert.
function fakeEmbedding(firstValue: number): number[] {
  return [firstValue, ...Array(1023).fill(0)];
}

async function createTestOrgMatterDocument(): Promise<{ orgId: string; matterId: string; documentId: string }> {
  const orgId = `org_test_${randomUUID()}`;

  return withOrgSession(orgId, async (client) => {
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
      orgId,
      "document chunks test matter",
    ]);
    const matterId = matterRow.rows[0].id;
    await initMatterGuidCounter(client, matterId);

    const documentId = randomUUID();
    await client.query(
      `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
       VALUES ($1, $2, $3, NULL, $1, 0, 1, 'chunked.pdf', 'pdf', 100, 'tenants/test/x/original.pdf', 'pdf', 'ready')`,
      [documentId, orgId, matterId],
    );
    return { orgId, matterId, documentId };
  });
}

describe("replaceDocumentChunks", () => {
  let cleanupOrgId: string | null = null;

  afterEach(async () => {
    if (cleanupOrgId) await deleteTestOrg(cleanupOrgId);
    cleanupOrgId = null;
  });

  it("stores real vector embeddings, retrievable with their chunk_index and text intact", async () => {
    const { orgId, matterId, documentId } = await createTestOrgMatterDocument();
    cleanupOrgId = orgId;

    await withOrgSession(orgId, (client) =>
      replaceDocumentChunks(client, {
        orgId,
        matterId,
        documentId,
        chunks: [
          { text: "first chunk", embedding: fakeEmbedding(0.1) },
          { text: "second chunk", embedding: fakeEmbedding(0.4) },
        ],
      }),
    );

    const rows = await withOrgSession(orgId, (client) =>
      client.query<{ chunk_index: number; text: string; embedding: string }>(
        "SELECT chunk_index, text, embedding::text FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index",
        [documentId],
      ),
    );

    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ chunk_index: 0, text: "first chunk" });
    expect(rows.rows[0].embedding.startsWith("[0.1,0,0,")).toBe(true);
    expect(rows.rows[1]).toMatchObject({ chunk_index: 1, text: "second chunk" });
  });

  it("replaces (not appends to) existing chunks on a second call — chunk count/boundaries can legitimately shrink on re-embedding", async () => {
    const { orgId, matterId, documentId } = await createTestOrgMatterDocument();
    cleanupOrgId = orgId;

    await withOrgSession(orgId, (client) =>
      replaceDocumentChunks(client, {
        orgId,
        matterId,
        documentId,
        chunks: [
          { text: "a", embedding: fakeEmbedding(0.1) },
          { text: "b", embedding: fakeEmbedding(0.2) },
          { text: "c", embedding: fakeEmbedding(0.3) },
        ],
      }),
    );
    await withOrgSession(orgId, (client) =>
      replaceDocumentChunks(client, {
        orgId,
        matterId,
        documentId,
        chunks: [{ text: "only one now", embedding: fakeEmbedding(0.9) }],
      }),
    );

    const rows = await withOrgSession(orgId, (client) =>
      client.query("SELECT text FROM document_chunks WHERE document_id = $1", [documentId]),
    );
    expect(rows.rows).toEqual([{ text: "only one now" }]);
  });

  it("is cascade-deleted when the owning document is deleted", async () => {
    const { orgId, matterId, documentId } = await createTestOrgMatterDocument();
    cleanupOrgId = orgId;

    await withOrgSession(orgId, (client) =>
      replaceDocumentChunks(client, { orgId, matterId, documentId, chunks: [{ text: "x", embedding: fakeEmbedding(0.1) }] }),
    );
    await withOrgSession(orgId, (client) => client.query("DELETE FROM documents WHERE id = $1", [documentId]));

    const rows = await withOrgSession(orgId, (client) =>
      client.query("SELECT 1 FROM document_chunks WHERE document_id = $1", [documentId]),
    );
    expect(rows.rows).toHaveLength(0);
  });
});
