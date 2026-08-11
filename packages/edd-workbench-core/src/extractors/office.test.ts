import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractOfficeMetadata } from "./office.js";

// Real docProps/core.xml content, from the actual OOXML core-properties
// schema — not a stub. Built into a genuine zip via jszip, the same format
// a real .docx/.xlsx/.pptx is, rather than needing a real Office file on
// disk as a fixture.
const CORE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Witness Statement Draft</dc:title>
  <dc:subject>Draft for review</dc:subject>
  <dc:creator>Jane Reviewer</dc:creator>
  <cp:lastModifiedBy>Jane Reviewer</cp:lastModifiedBy>
</cp:coreProperties>`;

async function buildFixtureZip(coreXml: string | null): Promise<Buffer> {
  const zip = new JSZip();
  if (coreXml !== null) zip.file("docProps/core.xml", coreXml);
  zip.file("[Content_Types].xml", "<Types/>"); // present in every real Office file; irrelevant to this extractor
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("extractOfficeMetadata", () => {
  it("extracts title/author/subject from a real docProps/core.xml", async () => {
    const buffer = await buildFixtureZip(CORE_XML);
    const result = await extractOfficeMetadata(buffer);

    expect(result.title).toBe("Witness Statement Draft");
    expect(result.author).toBe("Jane Reviewer");
    expect(result.subject).toBe("Draft for review");
  });

  it("returns nulls rather than throwing when docProps/core.xml is absent", async () => {
    const buffer = await buildFixtureZip(null);
    const result = await extractOfficeMetadata(buffer);

    expect(result).toEqual({ title: null, author: null, subject: null });
  });

  it("returns nulls rather than throwing for bytes that aren't a zip at all", async () => {
    const result = await extractOfficeMetadata(Buffer.from("not a zip file"));
    expect(result).toEqual({ title: null, author: null, subject: null });
  });
});
