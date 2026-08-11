import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Tesseract from "tesseract.js";

// pdfjs-dist's JBig2/OpenJPEG image decoders (the codecs scanners actually
// use) are WASM and need an explicit filesystem location under Node — left
// at its browser-bundler default, decoding silently no-ops (page "renders"
// but comes out blank) instead of throwing, which is why the previous
// OCR-retry path looked like it ran but never actually recovered any text.
const wasmUrl = path.join(path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json"))), "wasm") + "/";

// A scanned page rendered at the PDF's native ~72-96 DPI is too coarse for
// reliable OCR; 2x roughly approximates a 150-200 DPI scan, which is enough
// for typical office-scanner output without ballooning render/OCR time.
const RENDER_SCALE = 2.0;
// Bounds worst-case runtime for a pathologically long scanned PDF (OCR runs
// synchronously per document at ~1-5s/page) rather than leaving it
// unbounded — same rationale as the recursion/attempt caps used elsewhere.
const MAX_OCR_PAGES = 50;

export async function ocrScannedPdf(filePath: string): Promise<string | null> {
  let doc;
  try {
    const data = new Uint8Array(await readFile(filePath));
    doc = await getDocument({ data, disableFontFace: true, wasmUrl }).promise;
  } catch (err) {
    console.warn(`PDF OCR: failed to open ${filePath}: ${(err as Error).message}`);
    return null;
  }

  const pageCount = Math.min(doc.numPages, MAX_OCR_PAGES);
  if (doc.numPages > MAX_OCR_PAGES) {
    console.warn(`PDF OCR: ${filePath} has ${doc.numPages} pages, only OCR-ing the first ${MAX_OCR_PAGES}`);
  }

  const pageTexts: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    try {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      const pngBuffer = canvas.toBuffer("image/png");
      const { data: ocrData } = await Tesseract.recognize(pngBuffer, "eng");
      if (ocrData.text?.trim()) pageTexts.push(ocrData.text.trim());
    } catch (err) {
      console.warn(`PDF OCR: page ${i} of ${filePath} failed: ${(err as Error).message}`);
    }
  }

  const text = pageTexts.join("\n\n").trim();
  return text || null;
}
