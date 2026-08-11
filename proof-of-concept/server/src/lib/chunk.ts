export interface TextChunk {
  index: number;
  text: string;
}

// Character-based windows as a token-count proxy (~4 chars/token), so a
// ~3000-char chunk is roughly 750 tokens — well within any local model's
// context window, with enough overlap that an idea split across a chunk
// boundary still appears whole in at least one chunk.
const CHUNK_CHARS = 3000;
const OVERLAP_CHARS = 300;

export function chunkText(text: string): TextChunk[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_CHARS) return [{ index: 0, text: clean }];

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_CHARS, clean.length);
    chunks.push({ index, text: clean.slice(start, end) });
    index++;
    if (end >= clean.length) break;
    start = end - OVERLAP_CHARS;
  }
  return chunks;
}
