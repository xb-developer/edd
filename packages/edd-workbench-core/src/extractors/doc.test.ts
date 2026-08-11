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
  it("detects and extracts a genuine legacy OLE2/CFB .doc via word-extractor", async () => {
    const result = await extractDocContent(FIXTURE_LEGACY_DOC);

    expect(result.detectedFormat).toBe("doc");
    expect(result.text).toContain("This is a test of reviewing");
    expect(result.html).toBeNull();
  });

  it("detects a real .docx mislabeled with a .doc extension via its zip magic bytes, and extracts it as docx", async () => {
    const buffer = await buildFixtureDocxDisguisedAsDoc();
    const result = await extractDocContent(buffer);

    expect(result.detectedFormat).toBe("docx");
    expect(result.html).toContain("Please review the attached draft.");
    expect(result.text).toBeNull();
  });

  it("detects real RTF content mislabeled with a .doc extension via its RTF magic bytes", async () => {
    const buffer = Buffer.from("{\\rtf1\\ansi Please review the attached draft.}");
    const result = await extractDocContent(buffer);

    expect(result.detectedFormat).toBe("rtf");
    expect(result.text).toBe("Please review the attached draft.");
    expect(result.html).toBeNull();
  });

  it("returns a null-shaped result rather than throwing for bytes that are neither zip, RTF, nor a real OLE2 doc", async () => {
    const result = await extractDocContent(Buffer.from("not a real document of any kind"));

    expect(result.detectedFormat).toBe("doc");
    expect(result.text).toBeNull();
    expect(result.html).toBeNull();
  });
});
