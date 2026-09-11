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
  if (params.chunks.length === 0) return;

  // One batched INSERT via unnest(), not one sequential round-trip per
  // chunk — a document chunked into a few hundred pieces (easily reached
  // by a multi-hundred-KB extracted text at chunking.ts's ~1200-char
  // chunk size) previously meant that many serialized awaits per document
  // during embedding.
  const indexes = params.chunks.map((_, i) => i);
  const texts = params.chunks.map((chunk) => chunk.text);
  const embeddings = params.chunks.map((chunk) => toVectorLiteral(chunk.embedding));
  await client.query(
    `INSERT INTO document_chunks (org_id, matter_id, document_id, chunk_index, text, embedding)
     SELECT $1, $2, $3, u.chunk_index, u.text, u.embedding::vector
     FROM unnest($4::int[], $5::text[], $6::text[]) AS u(chunk_index, text, embedding)`,
    [params.orgId, params.matterId, params.documentId, indexes, texts, embeddings],
  );
}
