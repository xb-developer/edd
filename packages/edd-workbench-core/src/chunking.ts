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
      // Bounded to just this chunk's own slice — text.lastIndexOf(" ", end)
      // on the WHOLE string would otherwise scan backward from `end` with
      // no lower bound, all the way to index 0 when the span has no space
      // at all (e.g. garbled OCR output or a stray base64 blob, both of
      // which have actually reached this function in production — see
      // embeddableText.ts's own comment). That turned chunking O(n²) on
      // whitespace-sparse text; slicing first keeps each lookup O(chunkSize).
      const lastSpace = text.slice(start, end).lastIndexOf(" ");
      if (lastSpace > 0) end = start + lastSpace;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    start = end;
  }
  return chunks;
}
