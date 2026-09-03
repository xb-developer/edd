import type { PoolClient } from "pg";

export interface DocumentChunkInput {
  text: string;
  embedding: number[];
}

// pgvector's text input format for a vector literal is `[1,2,3]`, cast to
// ::vector in the query itself — the `pg` driver has no native vector
// type support, and this is simpler/more direct than pulling in the
// separate `pgvector` npm package's type-registration helper for one
// straightforward format. Exported since ask.ts needs the identical
// conversion to bind a question's own embedding into a similarity query.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Replaces all of a document's chunks — delete-then-insert, not upsert,
 * since re-embedding (e.g. after a retry, or a chunking-strategy change)
 * can change both the chunk count and each chunk's own boundaries, so
 * there's no stable chunk_index to upsert against.
 */
export async function replaceDocumentChunks(
  client: PoolClient,
  params: { orgId: string; matterId: string; documentId: string; chunks: DocumentChunkInput[] },
): Promise<void> {
  await client.query("DELETE FROM document_chunks WHERE document_id = $1", [params.documentId]);
  for (const [index, chunk] of params.chunks.entries()) {
    await client.query(
      "INSERT INTO document_chunks (org_id, matter_id, document_id, chunk_index, text, embedding) VALUES ($1, $2, $3, $4, $5, $6::vector)",
      [params.orgId, params.matterId, params.documentId, index, chunk.text, toVectorLiteral(chunk.embedding)],
    );
  }
}
