import { describe, expect, it } from "vitest";
import { chunkText } from "./chunking.js";

describe("chunkText", () => {
  it("returns the whole text as one chunk when it's under the chunk size", () => {
    expect(chunkText("short text", 100)).toEqual(["short text"]);
  });

  it("returns nothing for empty input", () => {
    expect(chunkText("", 100)).toEqual([]);
  });

  it("splits on the last whitespace boundary at or before the target size, not mid-word", () => {
    const text = "one two three four five six seven eight nine ten";
    const chunks = chunkText(text, 15);
    for (const chunk of chunks) {
      expect(text).toContain(chunk);
    }
    expect(chunks.join(" ")).toBe(text);
    // None of the split points should have cut a word in half.
    for (const chunk of chunks) {
      expect(/^\S+(\s\S+)*$/.test(chunk)).toBe(true);
    }
  });

  it("falls back to a hard cut when a single 'word' is longer than the chunk size", () => {
    const text = "a".repeat(50);
    const chunks = chunkText(text, 20);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
  });

  it("reassembles to the original text (modulo whitespace at split points)", () => {
    const text = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(text, 30);
    expect(chunks.join(" ")).toBe(text);
  });

  // Regression test: the space search used to scan backward from `end`
  // with no lower bound, so a long whitespace-free span (garbled OCR
  // output or a stray base64 blob reaching this function — both have
  // happened in production, see embeddableText.ts's own comment) made
  // chunking effectively O(n²). This exercises exactly that shape at a
  // size that would time out a quadratic implementation.
  it("stays fast and correct on a long run of text with no spaces at all", () => {
    const text = "a".repeat(500_000);
    const start = performance.now();
    const chunks = chunkText(text, 1200);
    const elapsedMs = performance.now() - start;

    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => c.length <= 1200)).toBe(true);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
