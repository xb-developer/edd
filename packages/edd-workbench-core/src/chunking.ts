const DEFAULT_CHUNK_SIZE = 1200;

/**
 * Splits text into ~chunkSize-character chunks, breaking on whitespace
 * where possible rather than mid-word. A rough, good-enough boundary for
 * embedding purposes — not sentence/paragraph-aware chunking, which is a
 * reasonable refinement once real retrieval quality is being tuned
 * against actual documents, not before there's a retrieval feature to
 * tune at all (see the RAG architecture memory's own chunking caveat:
 * numbers like this are workload-specific and expected to be revisited).
 */
export function chunkText(text: string, chunkSize: number = DEFAULT_CHUNK_SIZE): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > start) end = lastSpace;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    start = end;
  }
  return chunks;
}
