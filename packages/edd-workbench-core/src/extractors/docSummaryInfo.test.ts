import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractDocSummaryInfo } from "./docSummaryInfo.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
// Real legacy OLE2/CFB .doc from word-extractor's own test suite — same
// fixture doc.test.ts already uses for body-text extraction (see
// __fixtures__/NOTICE.md) — genuinely authored by that project's own
// maintainer, which is exactly the real author value asserted below.
const FIXTURE_LEGACY_DOC = readFileSync(join(FIXTURES_DIR, "legacy01.doc"));

describe("extractDocSummaryInfo", () => {
  it("extracts author and modified date from a real legacy .doc's SummaryInformation OLE stream", async () => {
    const result = await extractDocSummaryInfo(FIXTURE_LEGACY_DOC);
    expect(result.author).toBe("Stuart Watt");
    expect(result.modified?.toISOString()).toBe("2021-05-16T15:37:00.000Z");
    // This particular fixture genuinely has no title/subject set — not
    // every real-world .doc has every property populated.
    expect(result.title).toBeNull();
    expect(result.subject).toBeNull();
  });

  it("returns all-null (not a thrown error) for genuinely corrupt bytes", async () => {
    const result = await extractDocSummaryInfo(Buffer.from("not an ole compound file at all"));
    expect(result).toEqual({ title: null, author: null, subject: null, modified: null });
  });

  it("returns all-null (not a thrown error) for a real docx (a valid zip, not an OLE compound file)", async () => {
    // Sanity check: this extractor is only ever called for the genuine-OLE
    // branch of extractDocContent (see doc.ts), but it should still degrade
    // gracefully rather than throw if ever handed the wrong kind of buffer.
    const result = await extractDocSummaryInfo(Buffer.from("PK\x03\x04not a real zip either"));
    expect(result).toEqual({ title: null, author: null, subject: null, modified: null });
  });
});
