import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { extractText } from "../src/extraction/extract.js";

/** Hand-built minimal OOXML docx — mammoth only needs these three parts. */
async function buildDocx(text: string): Promise<Buffer> {
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
  zip
    .folder("_rels")!
    .file(
      ".rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    );
  zip
    .folder("word")!
    .file(
      "document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`,
    );
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Hand-built minimal OOXML pptx — one slide, one text run. */
async function buildPptx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
  );
  zip
    .folder("_rels")!
    .file(
      ".rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
    );
  zip
    .folder("ppt")!
    .file(
      "presentation.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`,
    );
  zip
    .folder("ppt/_rels")!
    .file(
      "presentation.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
    );
  zip
    .folder("ppt/slides")!
    .file(
      "slide1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
    );
  zip
    .folder("ppt/slides/_rels")!
    .file(
      "slide1.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
    );
  return zip.generateAsync({ type: "nodebuffer" });
}

test("extracts text from a genuine .docx (Word)", async () => {
  const buffer = await buildDocx("SETTLEMENT FIGURES CONFIDENTIAL");
  const text = await extractText(buffer, "settlement.docx");
  assert.match(text, /SETTLEMENT FIGURES CONFIDENTIAL/);
});

test("extracts text from a genuine .xlsx (Excel), across all sheets", async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Claimant", "Amount"], ["Jones Ltd", "42000"]]), "Sheet1");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["SECOND-SHEET-MARKER"]]), "Sheet2");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const text = await extractText(buffer, "figures.xlsx");
  assert.match(text, /Jones Ltd/);
  assert.match(text, /42000/);
  assert.match(text, /SECOND-SHEET-MARKER/, "text from every sheet must be included, not just the first");
});

test("extracts text from a legacy .xls (Excel 97-2003, BIFF binary)", async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["LEGACY-XLS-MARKER"]]), "Sheet1");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "biff8" }) as Buffer;

  const text = await extractText(buffer, "old-figures.xls");
  assert.match(text, /LEGACY-XLS-MARKER/);
});

test("extracts text from a genuine .pptx (PowerPoint)", async () => {
  const buffer = await buildPptx("DISCOVERY TIMELINE OVERVIEW");
  const text = await extractText(buffer, "timeline.pptx");
  assert.match(text, /DISCOVERY TIMELINE OVERVIEW/);
});

test("a .doc that is actually a renamed .docx is sniffed and routed correctly, not rejected", async () => {
  const buffer = await buildDocx("MISLABELLED WORD DOCUMENT");
  const text = await extractText(buffer, "renamed.doc");
  assert.match(text, /MISLABELLED WORD DOCUMENT/);
});

test("extracts a searchable header plus body from a .eml", async () => {
  const raw = [
    "From: Alice Counsel <alice@example.com>",
    "To: Bob Solicitor <bob@example.com>",
    "Subject: Case Update - Settlement Figures",
    "Date: Mon, 1 Jan 2024 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please see the attached settlement figures for review.",
    "",
  ].join("\r\n");

  const text = await extractText(Buffer.from(raw, "utf8"), "update.eml");
  assert.match(text, /Subject: Case Update - Settlement Figures/);
  assert.match(text, /From:.*alice@example\.com/);
  assert.match(text, /To:.*bob@example\.com/);
  assert.match(text, /Please see the attached settlement figures for review\./);
});

test("an unsupported format still fails extraction visibly (unchanged behaviour)", async () => {
  await assert.rejects(extractText(Buffer.from("data"), "mystery.xyz"), /unsupported format/);
});
