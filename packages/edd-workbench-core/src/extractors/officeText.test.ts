import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractOfficeText } from "./officeText.js";

// A minimal but genuinely valid .odt — real ODF package structure (mimetype
// + manifest.xml + content.xml), packaged as a real zip via jszip, matching
// the same hand-built-real-fixture convention used for docx/pptx. Verified
// empirically to parse correctly with officeparser before writing this test.
async function buildFixtureOdt(paragraphText: string, includeMetadata = false): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.text", { compression: "STORE" });
  zip.file(
    "META-INF/manifest.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`,
  );
  if (includeMetadata) {
    zip.file(
      "meta.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.4">
  <office:meta>
    <dc:title>Witness Statement Draft</dc:title>
    <dc:subject>Draft for review</dc:subject>
    <dc:creator>Jane Reviewer</dc:creator>
    <dc:date>2026-01-15T10:30:00</dc:date>
  </office:meta>
</office:document-meta>`,
    );
  }
  zip.file(
    "content.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:text>
      <text:p>${paragraphText}</text:p>
    </office:text>
  </office:body>
</office:document-content>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function buildFixtureEpub(options: { omitDctermsModified?: boolean } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  zip.file(
    "content.opf",
    `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Witness Statement Draft</dc:title>
    <dc:subject>Draft for review</dc:subject>
    <dc:creator>Jane Reviewer</dc:creator>
    <dc:date>2026-01-15T10:30:00Z</dc:date>
    ${options.omitDctermsModified ? "" : '<meta property="dcterms:modified">2026-01-15T10:30:00Z</meta>'}
  </metadata>
  <manifest></manifest>
  <spine></spine>
</package>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("extractOfficeText", () => {
  it("extracts text from a real .odt", async () => {
    const buffer = await buildFixtureOdt("Please review the attached draft.");
    const result = await extractOfficeText(buffer, "odt");

    expect(result.text).toBe("Please review the attached draft.");
  });

  it("extracts a real RTF's plain text", async () => {
    const buffer = Buffer.from("{\\rtf1\\ansi Please review the attached \\b draft\\b0 .}");
    const result = await extractOfficeText(buffer, "rtf");

    expect(result.text).toBe("Please review the attached draft.");
  });

  it("extracts title and text from a real HTML document, using the explicit fileType hint (HTML has no magic bytes to auto-detect from a buffer)", async () => {
    const buffer = Buffer.from("<html><head><title>Witness Statement Draft</title></head><body><p>Please review the attached draft.</p></body></html>");
    const result = await extractOfficeText(buffer, "html");

    expect(result.title).toBe("Witness Statement Draft");
    expect(result.text).toBe("Please review the attached draft.");
  });

  it("extracts title/author/subject/modified from a real .odt's own meta.xml — same ODF metadata mechanism ods/odp share", async () => {
    const buffer = await buildFixtureOdt("Please review the attached draft.", true);
    const result = await extractOfficeText(buffer, "odt");

    expect(result.title).toBe("Witness Statement Draft");
    expect(result.author).toBe("Jane Reviewer");
    expect(result.subject).toBe("Draft for review");
    expect(result.modified?.toISOString()).toBe(new Date("2026-01-15T10:30:00").toISOString());
    expect(result.text).toBe("Please review the attached draft.");
  });

  it("extracts title/author/subject/modified from a real .epub's OPF metadata — modified is read directly from dcterms:modified as a workaround for a confirmed gap in officeparser itself: EpubParser.js never populates ast.metadata.modified for epub at all, despite its own type declaration documenting that it should", async () => {
    const buffer = await buildFixtureEpub();
    const result = await extractOfficeText(buffer, "epub");

    expect(result.title).toBe("Witness Statement Draft");
    expect(result.author).toBe("Jane Reviewer");
    expect(result.subject).toBe("Draft for review");
    expect(result.modified?.toISOString()).toBe("2026-01-15T10:30:00.000Z");
  });

  it("falls back to dc:date for the epub modified workaround when no explicit dcterms:modified meta-refinement exists", async () => {
    const buffer = await buildFixtureEpub({ omitDctermsModified: true });
    const result = await extractOfficeText(buffer, "epub");

    expect(result.modified?.toISOString()).toBe("2026-01-15T10:30:00.000Z");
  });

  it("returns nulls rather than throwing for bytes that don't match the declared fileType", async () => {
    const result = await extractOfficeText(Buffer.from("not a real odt file"), "odt");
    expect(result).toEqual({ title: null, author: null, subject: null, modified: null, text: null });
  });
});
