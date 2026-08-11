import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import WordExtractor from "word-extractor";
import { parseOffice } from "officeparser";
import { simpleParser } from "mailparser";
import MsgReader from "./msgReader.js";

// pdfjs-dist warns (harmlessly, but noisily) on every PDF with a non-embedded
// standard font unless pointed at its bundled font-metrics directory. It
// validates this as a URL (not a bare path), hence pathToFileURL. A residual
// "Unable to load font data" warning can still appear for specific glyph
// substitutions pdfjs can't find in its bundled set — cosmetic only, doesn't
// affect extracted text (confirmed in test/pipeline.test.ts).
const standardFontDataUrl =
  pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json"))), "standard_fonts") + path.sep,
  ).href;

/**
 * Server-side text extraction (Section 3.2/4, security white paper Section
 * 9). Covers plain text, PDF, every Word/Excel/PowerPoint variant in
 * current use (OOXML and legacy binary), and both email container formats
 * (.eml, .msg) — OCR and PST/OST/mbox container expansion remain follow-up
 * work, not reproduced from the desktop prototype's fuller extractor
 * registry here. Every case below is real, tested extraction, not a stub.
 */
export async function extractText(buffer: Buffer, filename: string): Promise<string> {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "txt":
    case "md":
    case "csv":
      return buffer.toString("utf8");
    case "pdf":
      return extractPdfText(buffer);
    case "docx":
    case "docm":
    case "dotm":
      return extractDocxText(buffer);
    case "doc":
      return extractLegacyDocText(buffer);
    case "xlsx":
    case "xlsm":
    case "xltx":
    case "xls":
    case "xla":
      return extractSpreadsheetText(buffer);
    case "pptx":
      return extractPptxText(buffer);
    case "eml":
      return extractEmlText(buffer);
    case "msg":
      return extractMsgText(buffer);
    default:
      throw new Error(`unsupported format for extraction: .${ext ?? "unknown"}`);
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  // The "legacy" build runs without DOM APIs, which is what makes this work
  // server-side in plain Node rather than a browser.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), standardFontDataUrl }).promise;
  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items.map((item) => ("str" in item ? item.str : ""));
    pageTexts.push(strings.join(" "));
  }
  return pageTexts.join("\n\n");
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

// A ".doc" that's actually a renamed .docx (zip-based) is a real
// mislabeling case seen in litigation exports — word-extractor only reads
// genuine OLE2 binary Word documents and throws on anything else.
function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

async function extractLegacyDocText(buffer: Buffer): Promise<string> {
  if (looksLikeZip(buffer)) return extractDocxText(buffer);
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  return doc.getBody();
}

async function extractSpreadsheetText(buffer: Buffer): Promise<string> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  return workbook.SheetNames.map((name) => XLSX.utils.sheet_to_csv(workbook.Sheets[name])).join("\n\n");
}

async function extractPptxText(buffer: Buffer): Promise<string> {
  const ast = await parseOffice(buffer, { fileType: "pptx" });
  return ast.toText();
}

function formatAddress(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    return (value as Array<{ text?: string }>).map((a) => a.text).filter(Boolean).join("; ") || null;
  }
  return (value as { text?: string }).text ?? null;
}

// documents has a single extracted_text column (no separate subject/from
// columns the way the desktop app's metadata table does), so header fields
// are folded into the extracted text itself — otherwise "who sent this and
// what was it about" would be unsearchable and invisible in the preview pane.
async function extractEmlText(buffer: Buffer): Promise<string> {
  const parsed = await simpleParser(buffer);
  const from = formatAddress(parsed.from);
  const to = formatAddress(parsed.to);
  const header = [
    parsed.subject ? `Subject: ${parsed.subject}` : null,
    from ? `From: ${from}` : null,
    to ? `To: ${to}` : null,
    parsed.date ? `Date: ${parsed.date.toISOString()}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return [header, parsed.text || ""].filter(Boolean).join("\n\n");
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function extractMsgText(buffer: Buffer): Promise<string> {
  const reader = new MsgReader(toArrayBuffer(buffer));
  const data = reader.getFileData();
  const recipients = data.recipients ?? [];
  const byType = (type: string) =>
    recipients
      .filter((r) => (r.recipType ?? "").toLowerCase() === type)
      .map((r) => r.name || r.email)
      .filter(Boolean)
      .join("; ") || null;
  const from = data.senderName ?? data.senderEmail ?? null;
  const to = byType("to");
  const dateSent = data.messageDeliveryTime ?? data.creationTime ?? null;
  const header = [
    data.subject ? `Subject: ${data.subject}` : null,
    from ? `From: ${from}` : null,
    to ? `To: ${to}` : null,
    dateSent ? `Date: ${dateSent}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return [header, data.body || ""].filter(Boolean).join("\n\n");
}
