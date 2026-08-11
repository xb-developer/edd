/**
 * Splits text into overlapping chunks by word count — a plain, dependency-free
 * approximation of token-based chunking (~500-800 tokens/chunk with overlap,
 * matching the desktop prototype's RAG indexing scheme). Good enough given
 * embedding models are tolerant of imprecise boundaries; exactness isn't
 * worth pulling in a tokenizer for.
 */
export function chunkText(text: string, opts: { wordsPerChunk?: number; overlapWords?: number } = {}): string[] {
  const wordsPerChunk = opts.wordsPerChunk ?? 350;
  const overlapWords = opts.overlapWords ?? 50;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + wordsPerChunk, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start = end - overlapWords;
  }
  return chunks;
}
