import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// pdfjs-dist needs a worker script path even outside a bundler/browser —
// resolved once at module load, same pattern as the "legacy" Node build's
// own documented setup. require.resolve works here because Node's CJS
// resolution algorithm is available via createRequire regardless of this
// module itself being ESM.
const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;

/**
 * Extracts a PDF's real embedded text layer — NOT OCR. Verified against a
 * real minimal PDF: a page with genuine text-drawing operators returns
 * that text; a page with none (e.g. a scanned page, which is really just
 * an embedded image with no text operators at all) returns an empty
 * string, not garbage or a thrown error — that emptiness is the caller's
 * signal to fall back to the OCR service instead (see ingest.ts).
 *
 * `verbosity: 0` (errors only) suppresses this library's routine "no exact
 * font substitute found" warnings — harmless here since only `item.str`
 * (the decoded text) is used, never rendering/kerning accuracy.
 */
export async function extractPdfTextLayer(buffer: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  try {
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return pageTexts.join("\n\n").trim();
  } finally {
    doc.cleanup();
  }
}
