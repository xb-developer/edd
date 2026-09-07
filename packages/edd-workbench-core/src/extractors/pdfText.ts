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

export interface PdfMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  /** The PDF's own ModDate (falling back to CreationDate if unset) — the document's own last-modified property, matching OfficeMetadata's `modified` field, NOT the uploaded file's browser-reported mtime. */
  modified: Date | null;
}

const NULL_PDF_METADATA: PdfMetadata = { title: null, author: null, subject: null, modified: null };

/**
 * PDF date values are the spec's own `D:YYYYMMDDHHmmSSOHH'mm'` format, not
 * ISO 8601 — everything after the 4-digit year is optional, and real-world
 * PDFs commonly omit the timezone offset entirely. Returns null (not an
 * Invalid Date) for anything that doesn't at least match a 4-digit year.
 */
function parsePdfDate(value: string | undefined): Date | null {
  if (!value) return null;
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value);
  if (!match) return null;
  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00"] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Pulls title/author/subject/modified out of a PDF's own Info dictionary
 * (/Title, /Author, /Subject, /ModDate|/CreationDate) — the PDF equivalent
 * of docProps/core.xml for Office Open XML files (see office.ts). Returns
 * nulls rather than throwing for anything unreadable, same defensive
 * contract as extractOfficeMetadata: a single corrupt/unusual PDF's
 * metadata must never take down the rest of an ingest batch. Independent
 * of extractPdfTextLayer — a scanned PDF with no real text layer (headed
 * to OCR) can still have real Info-dictionary metadata worth keeping.
 */
export async function extractPdfMetadata(buffer: Buffer): Promise<PdfMetadata> {
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
    const { info } = await doc.getMetadata();
    const dict = info as Record<string, unknown>;
    return {
      title: typeof dict.Title === "string" && dict.Title.trim() ? dict.Title : null,
      author: typeof dict.Author === "string" && dict.Author.trim() ? dict.Author : null,
      subject: typeof dict.Subject === "string" && dict.Subject.trim() ? dict.Subject : null,
      modified: parsePdfDate(typeof dict.ModDate === "string" ? dict.ModDate : undefined) ?? parsePdfDate(typeof dict.CreationDate === "string" ? dict.CreationDate : undefined),
    };
  } catch {
    return NULL_PDF_METADATA;
  } finally {
    doc?.cleanup();
  }
}
