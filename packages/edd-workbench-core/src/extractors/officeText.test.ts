import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractOfficeText } from "./officeText.js";

// A minimal but genuinely valid .odt — real ODF package structure (mimetype
// + manifest.xml + content.xml), packaged as a real zip via jszip, matching
// the same hand-built-real-fixture convention used for docx/pptx. Verified
// empirically to parse correctly with officeparser before writing this test.
async function buildFixtureOdt(paragraphText: string): Promise<Buffer> {
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

  it("returns nulls rather than throwing for bytes that don't match the declared fileType", async () => {
    const result = await extractOfficeText(Buffer.from("not a real odt file"), "odt");
    expect(result).toEqual({ title: null, author: null, subject: null, modified: null, text: null });
  });
});
