import { withTenantContext, type TenantContext } from "../db/pool.js";
import { chunkText } from "./chunk.js";
import { embedText } from "./ollama.js";

/**
 * Chunks a document's extracted text and embeds each chunk, scoped to its
 * matter/group/organization (Section 3.4/7 — every chunk carries its matter
 * id from the moment it's created, never inferred later).
 *
 * Deliberately does its own short read, then the slow embedding calls
 * outside any held transaction, then a short write — matching the
 * extraction job's pattern (src/extraction/processJobs.ts) rather than
 * holding a pooled connection open for every Ollama round trip.
 */
export async function embedDocument(tenant: TenantContext, documentId: string): Promise<{ chunksCreated: number }> {
  const doc = await withTenantContext(tenant, async (client) => {
    const { rows } = await client.query(
      "SELECT extracted_text, matter_id, organization_id, group_id FROM documents WHERE id = $1",
      [documentId],
    );
    return rows[0] as
      | { extracted_text: string | null; matter_id: string; organization_id: string; group_id: string }
      | undefined;
  });
  if (!doc) throw new Error(`document ${documentId} not found`);

  const chunks = chunkText(doc.extracted_text ?? "");
  const embeddings = await Promise.all(chunks.map((c) => embedText(c)));

  await withTenantContext(tenant, async (client) => {
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO chunks (document_id, matter_id, organization_id, group_id, chunk_index, text, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (document_id, chunk_index) DO NOTHING`,
        [documentId, doc.matter_id, doc.organization_id, doc.group_id, i, chunks[i], embeddings[i]],
      );
    }
  });

  return { chunksCreated: chunks.length };
}
