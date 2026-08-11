import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractDocxContent } from "./docx.js";

// A minimal but genuinely valid .docx — real OOXML WordprocessingML parts,
// packaged as a real zip via jszip, the same convention office.test.ts uses
// for docProps/core.xml. Built by hand rather than via a docx-authoring
// library so there's no second dependency's behavior standing between the
// fixture and what it's supposed to prove.
const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function documentXml(paragraphText: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${paragraphText}</w:t></w:r></w:p>
  </w:body>
</w:document>`;
}

async function buildFixtureDocx(paragraphText: string | null): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", RELS_XML);
  if (paragraphText !== null) zip.file("word/document.xml", documentXml(paragraphText));
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("extractDocxContent", () => {
  it("converts a real docx's body paragraph into HTML", async () => {
    const buffer = await buildFixtureDocx("Please review the attached draft.");
    const result = await extractDocxContent(buffer);

    expect(result.html).toContain("Please review the attached draft.");
    expect(result.html).toMatch(/<p>/);
  });

  it("returns null html rather than throwing when word/document.xml is absent", async () => {
    const buffer = await buildFixtureDocx(null);
    const result = await extractDocxContent(buffer);

    expect(result.html).toBeNull();
  });

  it("returns null html rather than throwing for bytes that aren't a zip at all", async () => {
    const result = await extractDocxContent(Buffer.from("not a zip file"));
    expect(result.html).toBeNull();
  });
});
