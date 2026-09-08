import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractDocContent } from "./doc.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
// Real legacy OLE2/CFB .doc from word-extractor's own test suite — see __fixtures__/NOTICE.md.
const FIXTURE_LEGACY_DOC = readFileSync(join(FIXTURES_DIR, "legacy01.doc"));

async function buildFixtureDocxDisguisedAsDoc(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Witness Statement Draft</dc:title>
  <dc:subject>Draft for review</dc:subject>
  <dc:creator>Jane Reviewer</dc:creator>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-15T10:30:00Z</dcterms:modified>
</cp:coreProperties>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Please review the attached draft.</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("extractDocContent", () => {
  it("detects and extracts a genuine legacy OLE2/CFB .doc via word-extractor, including its SummaryInformation author/modified", async () => {
    const result = await extractDocContent(FIXTURE_LEGACY_DOC);

    expect(result.detectedFormat).toBe("doc");
    expect(result.text).toContain("This is a test of reviewing");
    expect(result.html).toBeNull();
    // Real values from this fixture's own SummaryInformation OLE stream —
    // see docSummaryInfo.test.ts for the extractor's own dedicated tests.
    expect(result.author).toBe("Stuart Watt");
    expect(result.modified?.toISOString()).toBe("2021-05-16T15:37:00.000Z");
    expect(result.title).toBeNull();
  });

  it("detects a real .docx mislabeled with a .doc extension via its zip magic bytes, extracting it as docx (body HTML AND docProps title/author/subject/modified)", async () => {
    const buffer = await buildFixtureDocxDisguisedAsDoc();
    const result = await extractDocContent(buffer);

    expect(result.detectedFormat).toBe("docx");
    expect(result.html).toContain("Please review the attached draft.");
    expect(result.text).toBeNull();
    expect(result.title).toBe("Witness Statement Draft");
    expect(result.author).toBe("Jane Reviewer");
    expect(result.subject).toBe("Draft for review");
    expect(result.modified?.toISOString()).toBe(new Date("2026-01-15T10:30:00Z").toISOString());
  });

  it("detects real RTF content mislabeled with a .doc extension via its RTF magic bytes", async () => {
    const buffer = Buffer.from("{\\rtf1\\ansi Please review the attached draft.}");
    const result = await extractDocContent(buffer);

    expect(result.detectedFormat).toBe("rtf");
    expect(result.text).toBe("Please review the attached draft.");
    expect(result.html).toBeNull();
    // This minimal fixture has no \info metadata group at all — proves the
    // wiring degrades to null rather than crashing; real RTF metadata
    // parsing correctness is officeparser's/officeText.ts's own concern.
    expect(result.title).toBeNull();
    expect(result.author).toBeNull();
  });

  it("returns a null-shaped result rather than throwing for bytes that are neither zip, RTF, nor a real OLE2 doc", async () => {
    const result = await extractDocContent(Buffer.from("not a real document of any kind"));

    expect(result.detectedFormat).toBe("doc");
    expect(result.text).toBeNull();
    expect(result.html).toBeNull();
    expect(result.title).toBeNull();
    expect(result.author).toBeNull();
    expect(result.subject).toBeNull();
    expect(result.modified).toBeNull();
  });
});
