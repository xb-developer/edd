import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { simpleParser } from "mailparser";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import { parseOffice } from "officeparser";
import MsgReader from "./msgReader.js";
import { toArrayBuffer } from "./buffer.js";
import { extractPptxSlides } from "./pptxText.js";
import { looksLikeText, looksLikeRtf, looksLikeZip } from "./textSniff.js";
import { ocrImage } from "./ocr.js";
import { ocrScannedPdf } from "./pdfOcr.js";
import { extractLegacyPpt } from "./legacyPpt.js";

const xmlParser = new XMLParser({ ignoreAttributes: false });

export interface ExtractedMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  /** Sent date for emails, embedded document-created date for everything else. */
  dateCreated: string | null;
  /** Embedded last-modified date. Non-email formats only, since an email has no "modified" concept. */
  dateModified: string | null;
  /** Recipients ("To"), emails only. */
  to: string | null;
  /** Recipients ("Cc"), emails only. */
  cc: string | null;
  extra: Record<string, unknown> | null;
  /** Plain-text body content, fed into the full-text search index. */
  text: string | null;
}

const EMPTY: ExtractedMetadata = {
  title: null,
  author: null,
  subject: null,
  dateCreated: null,
  dateModified: null,
  to: null,
  cc: null,
  extra: null,
  text: null,
};

// Handled end-to-end by officeparser (text + metadata in one pass).
const OFFICEPARSER_EXTS = new Set(["odt", "ods", "odp", "pdf", "html", "htm", "rtf", "epub"]);
// Genuinely unsupported for content extraction — registered with filesystem
// metadata only. .dwg needs a paid CAD SDK (Autodesk/ODA/Aspose.CAD); .mpp
// (MS Project) has no viable pure-JS reader — Tika/POI only gives basic
// metadata without also pulling in MPXJ, which is LGPL-licensed.
const UNSUPPORTED_EXTS = new Set(["dwg", "mpp"]);
// A raster image has no native text layer at all — OCR is the only way in.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "tiff", "tif"]);
// Macro-enabled/template variants of formats already handled above — same
// OOXML zip+XML container, just a different usage flag, so the existing
// extractors work unchanged once routed.
const DOCX_LIKE_EXTS = new Set(["docx", "docm", "dotm"]);
const XLSX_LIKE_EXTS = new Set(["xlsx", "xlsm", "xltx"]);
// .xla (Excel 97-2003 add-in) is the same legacy BIFF container as .xls —
// mostly VBA code with little cell data, but named ranges/sheets still
// extract via the same reader.
const LEGACY_SHEET_EXTS = new Set(["xls", "xla"]);
// Legacy PowerPoint 97-2003 binary format — .ppt/.pps/.pot are the same
// underlying container (document/show/template), all readable via the same
// best-effort parser (see legacyPpt.ts for its real-world limitations).
const LEGACY_PPT_EXTS = new Set(["ppt", "pps", "pot"]);

export async function extractMetadata(filePath: string, extension: string): Promise<ExtractedMetadata> {
  const ext = extension.toLowerCase();
  try {
    if (DOCX_LIKE_EXTS.has(ext)) return await extractDocx(filePath);
    if (ext === "pptx") return await extractPptx(filePath);
    if (XLSX_LIKE_EXTS.has(ext)) return await extractOoxmlSheet(filePath);
    if (LEGACY_SHEET_EXTS.has(ext)) return await extractLegacySheet(filePath);
    if (ext === "doc") return await extractLegacyDoc(filePath);
    if (LEGACY_PPT_EXTS.has(ext)) return await extractLegacyPptMetadata(filePath);
    if (ext === "csv") return await extractPlainText(filePath);
    if (ext === "eml") return await extractEml(filePath);
    if (ext === "msg") return await extractMsg(filePath);
    if (OFFICEPARSER_EXTS.has(ext)) return await extractViaOfficeparser(filePath, ext);
    if (IMAGE_EXTS.has(ext)) return await extractImageOcr(filePath);
    if (UNSUPPORTED_EXTS.has(ext)) return EMPTY;
    // .zip/.pst/.ost/.mbox are containers, not content — their members
    // (messages, in the mail-container cases) are imported as their own
    // child documents, so the container itself carries no text/metadata.
    if (ext === "zip" || ext === "pst" || ext === "ost" || ext === "mbox") return EMPTY;
    return await extractGenericFallback(filePath);
  } catch (err) {
    console.warn(`Metadata extraction failed for ${filePath}: ${(err as Error).message}`);
    return EMPTY;
  }
}

async function extractLegacyPptMetadata(filePath: string): Promise<ExtractedMetadata> {
  const text = await extractLegacyPpt(filePath);
  return { ...EMPTY, text };
}

function pickText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "object" && value !== null && "#text" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)["#text"]).trim() || null;
  }
  return null;
}

// Reads docProps/core.xml from an OOXML zip container — dc:title /
// dc:creator / dc:subject.
async function readZipCoreProperties(
  filePath: string,
  entryName: string,
): Promise<{ title: string | null; author: string | null; subject: string | null; dateCreated: string | null; dateModified: string | null }> {
  const empty = { title: null, author: null, subject: null, dateCreated: null, dateModified: null };
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file(entryName);
  if (!entry) return empty;
  const xml = await entry.async("text");
  const parsed = xmlParser.parse(xml);
  const core = parsed["cp:coreProperties"] ?? parsed.coreProperties ?? {};
  return {
    title: pickText(core["dc:title"]),
    author: pickText(core["dc:creator"]),
    subject: pickText(core["dc:subject"]),
    dateCreated: pickText(core["dcterms:created"]),
    dateModified: pickText(core["dcterms:modified"]),
  };
}

async function extractDocx(filePath: string): Promise<ExtractedMetadata> {
  const core = await readZipCoreProperties(filePath, "docProps/core.xml");
  const buf = await readFile(filePath);
  const raw = await mammoth.extractRawText({ buffer: buf });
  return { ...core, to: null, cc: null, extra: null, text: raw.value || null };
}

async function extractPptx(filePath: string): Promise<ExtractedMetadata> {
  const core = await readZipCoreProperties(filePath, "docProps/core.xml");
  const slides = await extractPptxSlides(filePath);
  return { ...core, to: null, cc: null, extra: null, text: slides.map((s) => s.text).join("\n\n") || null };
}

async function extractOoxmlSheet(filePath: string): Promise<ExtractedMetadata> {
  const core = await readZipCoreProperties(filePath, "docProps/core.xml");
  const buf = await readFile(filePath);
  const wb = XLSX.read(buf, { type: "buffer" });
  const text = wb.SheetNames.map((name) => XLSX.utils.sheet_to_csv(wb.Sheets[name])).join("\n\n");
  return { ...core, to: null, cc: null, extra: null, text: text || null };
}

// Legacy binary .xls (BIFF) isn't a zip, so there's no docProps/core.xml —
// SheetJS's own workbook Props carry the same Title/Author/Subject fields.
async function extractLegacySheet(filePath: string): Promise<ExtractedMetadata> {
  const buf = await readFile(filePath);
  const wb = XLSX.read(buf, { type: "buffer" });
  const text = wb.SheetNames.map((name) => XLSX.utils.sheet_to_csv(wb.Sheets[name])).join("\n\n");
  const props = wb.Props as XLSX.FullProperties | undefined;
  return {
    title: props?.Title || null,
    author: props?.Author || null,
    subject: props?.Subject || null,
    dateCreated: props?.CreatedDate ? new Date(props.CreatedDate).toISOString() : null,
    dateModified: props?.ModifiedDate ? new Date(props.ModifiedDate).toISOString() : null,
    to: null,
    cc: null,
    extra: null,
    text: text || null,
  };
}

// Legacy binary .doc (OLE compound document) — word-extractor reads the
// body text directly; it doesn't expose document property metadata, so
// title/author are left null rather than guessed.
// A ".doc" extension is not reliable proof of genuine legacy OLE2 content —
// RTF (and occasionally a renamed .docx) saved with a .doc extension shows
// up in real litigation exports. word-extractor correctly rejects anything
// that isn't OLE2 ("Unable to read this type of file"), so sniff the real
// magic bytes first and route to the extractor that actually matches.
async function extractLegacyDoc(filePath: string): Promise<ExtractedMetadata> {
  const buf = await readFile(filePath);
  if (looksLikeRtf(buf)) return extractViaOfficeparser(filePath, "rtf", buf);
  if (looksLikeZip(buf)) return extractDocx(filePath);
  const extractor = new WordExtractor();
  const doc = await extractor.extract(filePath);
  return { ...EMPTY, text: doc.getBody() || null };
}

// A raster image has no text layer — the whole thing is OCR'd. The
// recognized text is duplicated into `extra.ocrText` (not just `text`) so
// the preview pane can show it next to the image for a sanity check.
async function extractImageOcr(filePath: string): Promise<ExtractedMetadata> {
  const text = await ocrImage(filePath);
  return { ...EMPTY, extra: text ? { ocr: true, ocrText: text } : null, text };
}

const OCR_RETRY_THRESHOLD = 20; // chars — below this, treat the document as having no real text layer

interface OfficeAstNode {
  type?: string;
  attachment?: { ocrText?: string };
  children?: OfficeAstNode[];
}

function collectImageOcrText(node: OfficeAstNode, out: string[]): void {
  if (node.type === "image" && node.attachment?.ocrText) out.push(node.attachment.ocrText);
  for (const child of node.children ?? []) collectImageOcrText(child, out);
}

// officeparser's own `{ ocr: true }` only OCRs images embedded as discrete
// attachments *within* a document (a picture pasted into an odt, say) — it
// never rasterizes a PDF page. A scanned PDF produces zero image nodes no
// matter what, so this retry silently did nothing for the single most
// common real-world case. PDFs get their own proper page-rasterize-then-OCR
// pipeline (lib/pdfOcr.ts); the other officeparser formats keep the
// embedded-image retry, now actually wired up correctly (extractAttachments
// must be set for `ocr` to have any effect, and the recovered text lives on
// each image node's `ocrText`, not in `ast.toText()`).
async function extractViaOfficeparser(filePath: string, ext: string, fileOverride?: Buffer): Promise<ExtractedMetadata> {
  // fileOverride is set when the caller already sniffed the real content and
  // it doesn't match the file's own extension (e.g. RTF saved as .doc) —
  // officeparser detects format from a path's extension, but correctly
  // content-sniffs when handed a Buffer directly instead.
  const file = fileOverride ?? filePath;
  const ast = await parseOffice(file);
  let text = ast.toText() || null;
  let usedOcr = false;

  if (!text || text.trim().length < OCR_RETRY_THRESHOLD) {
    try {
      if (ext === "pdf") {
        const ocrText = await ocrScannedPdf(filePath);
        if (ocrText && ocrText.length > (text?.trim().length ?? 0)) {
          text = ocrText;
          usedOcr = true;
        }
      } else {
        const ocrAst = await parseOffice(file, { extractAttachments: true, ocr: true });
        const imageTexts: string[] = [];
        collectImageOcrText(ocrAst, imageTexts);
        const ocrText = imageTexts.join("\n\n").trim() || null;
        if (ocrText && ocrText.length > (text?.trim().length ?? 0)) {
          text = ocrText;
          usedOcr = true;
        }
      }
    } catch (err) {
      console.warn(`OCR retry failed for ${filePath}: ${(err as Error).message}`);
    }
  }

  return {
    title: ast.metadata?.title ?? null,
    author: ast.metadata?.author ?? null,
    subject: ast.metadata?.subject ?? null,
    dateCreated: ast.metadata?.created ? new Date(ast.metadata.created).toISOString() : null,
    dateModified: ast.metadata?.modified ? new Date(ast.metadata.modified).toISOString() : null,
    to: null,
    cc: null,
    extra: usedOcr ? { ocr: true } : null,
    text,
  };
}

async function extractPlainText(filePath: string): Promise<ExtractedMetadata> {
  const text = await readFile(filePath, "utf-8");
  return { ...EMPTY, text: text || null };
}

// Anything not explicitly handled above: sniff for UTF-8-plausible text in
// the first few KB and extract it if so, otherwise register with
// filesystem metadata only. This is what lets a genuinely new/unforeseen
// format still show up with searchable text rather than being silently
// dropped, without pretending to support formats that need a real parser.
async function extractGenericFallback(filePath: string): Promise<ExtractedMetadata> {
  const buf = await readFile(filePath);
  if (!looksLikeText(buf)) return EMPTY;
  return { ...EMPTY, text: buf.toString("utf-8") || null };
}

function addressText(value: unknown): string | null {
  if (!value) return null;
  const v = value as { text?: string };
  if (Array.isArray(value)) return (value as { text?: string }[]).map((a) => a.text).filter(Boolean).join("; ") || null;
  return v.text ?? null;
}

async function extractEml(filePath: string): Promise<ExtractedMetadata> {
  const buf = await readFile(filePath);
  const parsed = await simpleParser(buf);
  const from = addressText(parsed.from);
  const to = addressText(parsed.to);
  const cc = addressText(parsed.cc);
  const dateSent = parsed.date ? parsed.date.toISOString() : null;
  return {
    title: parsed.subject ?? null,
    author: from,
    subject: parsed.subject ?? null,
    dateCreated: dateSent,
    dateModified: null,
    to,
    cc,
    extra: {
      from,
      to,
      cc,
      date: dateSent,
      attachmentCount: parsed.attachments?.length ?? 0,
    },
    text: parsed.text || null,
  };
}

async function extractMsg(filePath: string): Promise<ExtractedMetadata> {
  const buf = await readFile(filePath);
  const reader = new MsgReader(toArrayBuffer(buf));
  const data = reader.getFileData();
  const recipients: Array<{ name?: string; email?: string; recipType?: string }> = data.recipients ?? [];
  const byType = (t: string) =>
    recipients
      .filter((r) => (r.recipType ?? "").toLowerCase() === t)
      .map((r) => r.name || r.email)
      .filter(Boolean)
      .join("; ") || null;
  const author = data.senderName ?? data.senderEmail ?? null;
  const to = byType("to");
  const cc = byType("cc");
  const dateSent = data.messageDeliveryTime ?? data.creationTime ?? null;
  return {
    title: data.subject ?? null,
    author,
    subject: data.subject ?? null,
    dateCreated: dateSent,
    dateModified: null,
    to,
    cc,
    extra: {
      from: author,
      to,
      cc,
      date: dateSent,
      attachmentCount: (data.attachments ?? []).length,
    },
    text: data.body || null,
  };
}
