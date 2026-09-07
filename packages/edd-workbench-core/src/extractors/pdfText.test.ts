import { describe, expect, it } from "vitest";
import { extractPdfTextLayer, extractPdfMetadata } from "./pdfText.js";

// Minimal, genuinely-valid single-page PDFs — small enough to inline rather
// than needing a binary fixture file. One has real text-drawing operators
// (BT/Tj), the other has a byte-empty content stream, standing in for a
// scanned page with no text layer at all.
const PDF_WITH_TEXT_LAYER = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 58 >>
stream
BT /F1 18 Tf 10 50 Td (Real embedded text) Tj ET
endstream
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`);

const PDF_WITHOUT_TEXT_LAYER = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 5 0 R >>
endobj
5 0 obj
<< /Length 0 >>
stream

endstream
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`);

describe("extractPdfTextLayer", () => {
  it("extracts a real page's genuine text-drawing operators", async () => {
    const text = await extractPdfTextLayer(PDF_WITH_TEXT_LAYER);
    expect(text).toBe("Real embedded text");
  });

  it("returns an empty string for a page with no text-drawing operators at all — the caller's signal to fall back to OCR", async () => {
    const text = await extractPdfTextLayer(PDF_WITHOUT_TEXT_LAYER);
    expect(text).toBe("");
  });
});

// Same minimal single-page PDF as PDF_WITHOUT_TEXT_LAYER above, plus a real
// Info dictionary (object 6) referenced from the trailer — proves metadata
// extraction works independently of whether the page has a text layer (a
// scanned pdf, headed to OCR, can still have real /Author set).
const PDF_WITH_METADATA_NO_TEXT_LAYER = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 5 0 R >>
endobj
5 0 obj
<< /Length 0 >>
stream

endstream
endobj
6 0 obj
<< /Title (Witness Statement Draft) /Author (Jane Reviewer) /Subject (Draft for review) /ModDate (D:20260115120000+00'00') >>
endobj
xref
0 7
0000000000 65535 f
trailer
<< /Size 7 /Root 1 0 R /Info 6 0 R >>
startxref
0
%%EOF`);

const PDF_WITHOUT_METADATA = PDF_WITHOUT_TEXT_LAYER;

describe("extractPdfMetadata", () => {
  it("extracts title/author/subject/modified from a real PDF Info dictionary, independent of whether it has a text layer", async () => {
    const metadata = await extractPdfMetadata(PDF_WITH_METADATA_NO_TEXT_LAYER);
    expect(metadata.title).toBe("Witness Statement Draft");
    expect(metadata.author).toBe("Jane Reviewer");
    expect(metadata.subject).toBe("Draft for review");
    expect(metadata.modified?.toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });

  it("returns all-null (not an error) for a PDF with no Info dictionary at all", async () => {
    const metadata = await extractPdfMetadata(PDF_WITHOUT_METADATA);
    expect(metadata).toEqual({ title: null, author: null, subject: null, modified: null });
  });

  it("returns all-null (not a thrown error) for genuinely corrupt bytes", async () => {
    const metadata = await extractPdfMetadata(Buffer.from("not a pdf at all"));
    expect(metadata).toEqual({ title: null, author: null, subject: null, modified: null });
  });
});
