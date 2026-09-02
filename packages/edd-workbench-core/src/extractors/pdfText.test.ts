import { describe, expect, it } from "vitest";
import { extractPdfTextLayer } from "./pdfText.js";

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
