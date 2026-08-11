import { Router } from "express";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import { simpleParser } from "mailparser";
import MsgReader from "../lib/msgReader.js";
import { nameEmbeddedEmailAttachment } from "../lib/familyExtract.js";
import WordExtractor from "word-extractor";
import { parseOffice } from "officeparser";
import { createCanvas } from "@napi-rs/canvas";
import type * as UTIFTypes from "utif2";

// utif2 is `module.exports = UTIF` (a built object, not a static literal) —
// Node's ESM loader can't statically detect its named exports, so `import *
// as UTIF from "utif2"` silently gives a namespace with only `.default`
// populated (every named property, e.g. `.decode`, is `undefined`) rather
// than throwing, which makes the bug easy to miss until called. Same root
// cause already hit and fixed for @kenjiuno/msgreader in lib/msgReader.ts —
// a real CJS require sidesteps the interop entirely.
const require = createRequire(import.meta.url);
const UTIF = require("utif2") as typeof UTIFTypes;
import { getDb, type DocumentRow } from "../db.js";
import { parseCsv } from "../lib/csv.js";
import { toArrayBuffer } from "../lib/buffer.js";
import { extractPptxSlides } from "../lib/pptxText.js";
import { looksLikeText, looksLikeRtf, looksLikeZip } from "../lib/textSniff.js";
import { extractLegacyPpt } from "../lib/legacyPpt.js";

export const contentRouter = Router();

function getDoc(guid: string): DocumentRow | undefined {
  return getDb().prepare("SELECT * FROM documents WHERE guid = ?").get(guid) as unknown as DocumentRow | undefined;
}

const RAW_HTML_EXTS = new Set(["html", "htm"]);

contentRouter.get("/:guid/file", (req, res) => {
  const doc = getDoc(req.params.guid);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  if (RAW_HTML_EXTS.has(doc.extension.toLowerCase())) {
    // Rendered in a sandboxed <iframe> for preview (see htmlFile below) —
    // this document is untrusted (a real litigation document can contain
    // anything), so this CSP blocks every kind of outbound network fetch
    // (external images/scripts/fonts/frames/etc.) it could use as a "web
    // bug" to signal back to a third party that it was opened, while still
    // rendering the document's own inline content normally. Scoped to just
    // this extension — other file kinds served from this same route (PDFs,
    // images) aren't interpreted as a document that loads sub-resources,
    // so this header wouldn't mean anything for them.
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:;");
  }
  res.sendFile(doc.stored_path);
});

// Macro-enabled/template variants — same underlying container as the base
// format, so the existing readers (SheetJS auto-detects OOXML vs. legacy
// BIFF; mammoth doesn't care about the macro-enabled flag) handle them as-is.
const DOCX_LIKE_EXTS = new Set(["docx", "docm", "dotm"]);
const SHEET_EXTS = new Set(["xlsx", "xlsm", "xls", "xltx", "xla"]);
const LEGACY_PPT_EXTS = new Set(["ppt", "pps", "pot"]);
const TEXT_EXTS = new Set(["txt", "log", "json", "md", "xml", "csv"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg"]);
const TIFF_EXTS = new Set(["tif", "tiff"]);
const OFFICEPARSER_EXTS = new Set(["odt", "odp", "ods", "pdf", "rtf"]);
// .mpp (MS Project) has no viable pure-JS reader; .dwg needs a paid CAD SDK.
const UNSUPPORTED_EXTS = new Set(["dwg", "mpp"]);

contentRouter.get("/:guid/preview", async (req, res) => {
  const doc = getDoc(req.params.guid);
  if (!doc) return res.status(404).json({ error: "Document not found" });

  const ext = doc.extension.toLowerCase();
  try {
    if (DOCX_LIKE_EXTS.has(ext)) return res.json(await previewDocx(doc));
    if (ext === "doc") return res.json(await previewDoc(doc));
    if (SHEET_EXTS.has(ext)) return res.json(await previewSheets(doc));
    if (ext === "csv") return res.json(await previewCsv(doc));
    if (ext === "pptx") return res.json(await previewPptx(doc));
    if (LEGACY_PPT_EXTS.has(ext)) return res.json(await previewLegacyPpt(doc));
    if (ext === "eml") return res.json(await previewEml(doc));
    if (ext === "msg") return res.json(await previewMsg(doc));
    if (ext === "pdf") return res.json({ kind: "pdf" });
    if (IMAGE_EXTS.has(ext)) return res.json({ kind: "image" });
    if (TIFF_EXTS.has(ext)) return res.json(await previewTiff(doc));
    // A raw HTML *file* (as opposed to previewDocx's mammoth-generated HTML
    // below, which is safe to render inline since it's derived from a
    // parsed Word document, not passed through) is untrusted, arbitrary
    // content — rendered via a sandboxed iframe client-side instead of
    // dangerouslySetInnerHTML, which would execute any <script> tag with
    // full access to this app's own context. No content needs reading
    // here; the client points its iframe straight at /:guid/file.
    if (RAW_HTML_EXTS.has(ext)) return res.json({ kind: "htmlFile" });
    if (ext === "ods") return res.json(await previewOfficeparserSheets(doc));
    if (OFFICEPARSER_EXTS.has(ext)) return res.json(await previewOfficeparserText(doc));
    if (UNSUPPORTED_EXTS.has(ext)) return res.json({ kind: "unsupported" });
    if (TEXT_EXTS.has(ext)) return res.json(await previewText(doc));
    return res.json(await previewGenericFallback(doc));
  } catch (err) {
    res.status(500).json({ kind: "error", message: (err as Error).message });
  }
});

// TIFF has no native browser rendering support (unlike PNG/JPEG/etc in
// IMAGE_EXTS above) — decoded server-side with utif2 (pure JS, no native
// build step needed) into raw RGBA, then drawn onto @napi-rs/canvas (already
// a dependency for OCR page rendering) and re-encoded as PNG data URIs the
// client can put straight into <img src>. A TIFF can hold multiple pages
// (common for a scanned/faxed litigation document), so every IFD UTIF.decode
// finds is converted, not just the first.
async function previewTiff(doc: DocumentRow) {
  const buf = await readFile(doc.stored_path);
  const ifds = UTIF.decode(buf);
  const pages: string[] = [];
  for (const ifd of ifds) {
    UTIF.decodeImage(buf, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    const canvas = createCanvas(ifd.width, ifd.height);
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(ifd.width, ifd.height);
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);
    const png = await canvas.encode("png");
    pages.push(`data:image/png;base64,${png.toString("base64")}`);
  }
  return { kind: "tiff" as const, pages };
}

async function previewDocx(doc: DocumentRow) {
  const buf = await readFile(doc.stored_path);
  const result = await mammoth.convertToHtml({ buffer: buf });
  return { kind: "html" as const, html: result.value };
}

// A ".doc" extension is not reliable proof of genuine OLE2 content — RTF
// (and occasionally a renamed .docx) saved with a .doc extension shows up
// in real litigation exports; see the matching sniff in lib/metadata.ts.
async function previewDoc(doc: DocumentRow) {
  const buf = await readFile(doc.stored_path);
  if (looksLikeRtf(buf)) return previewOfficeparserText(doc, buf);
  if (looksLikeZip(buf)) return previewDocx(doc);
  const extractor = new WordExtractor();
  const extracted = await extractor.extract(doc.stored_path);
  return { kind: "text" as const, text: extracted.getBody() };
}

async function previewSheets(doc: DocumentRow) {
  const buf = await readFile(doc.stored_path);
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheets = wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" }) as string[][],
  }));
  return { kind: "sheets" as const, sheets };
}

async function previewCsv(doc: DocumentRow) {
  const text = await readFile(doc.stored_path, "utf-8");
  return { kind: "sheets" as const, sheets: [{ name: doc.original_name, rows: parseCsv(text) }] };
}

async function previewText(doc: DocumentRow) {
  const text = await readFile(doc.stored_path, "utf-8");
  // Rendered as plain text, not live HTML — an imported .html file is
  // untrusted content and must not execute script in the app's renderer.
  return { kind: "text" as const, text: text.slice(0, 500_000) };
}

async function previewGenericFallback(doc: DocumentRow) {
  const buf = await readFile(doc.stored_path);
  if (!looksLikeText(buf)) return { kind: "unsupported" as const };
  return { kind: "text" as const, text: buf.toString("utf-8").slice(0, 500_000) };
}

async function previewPptx(doc: DocumentRow) {
  const slides = await extractPptxSlides(doc.stored_path);
  return { kind: "slides" as const, slides };
}

async function previewLegacyPpt(doc: DocumentRow) {
  // Best-effort parser (see lib/legacyPpt.ts) — a plain-text block rather
  // than per-slide rendering, since it's not worth building slide UI around
  // a format this doesn't always successfully parse.
  const text = await extractLegacyPpt(doc.stored_path);
  if (!text) return { kind: "unsupported" as const };
  return { kind: "text" as const, text };
}

async function previewOfficeparserText(doc: DocumentRow, fileOverride?: Buffer) {
  // fileOverride is set when the caller already sniffed real content that
  // doesn't match the file's own extension — officeparser detects format
  // from a path's extension, but correctly content-sniffs given a Buffer.
  const ast = await parseOffice(fileOverride ?? doc.stored_path);
  return { kind: "text" as const, text: ast.toText().slice(0, 500_000) };
}

async function previewOfficeparserSheets(doc: DocumentRow) {
  // .ods (OpenDocument Spreadsheet) — reuse the plain-text rendering for now;
  // structured per-cell grid rendering is a fast-follow, not required for the
  // core "view + extract text" requirement.
  return previewOfficeparserText(doc);
}

async function previewEml(doc: DocumentRow) {
  const buf = await readFile(doc.stored_path);
  const parsed = await simpleParser(buf);
  // Inline body images (related: true — cid: referenced in the HTML body,
  // see familyExtract.ts) aren't real attachments — mailparser already
  // resolves their cid: references into self-contained data: URIs directly
  // in parsed.html, so they render correctly without needing to be listed
  // here; showing them in the attachment list would just contradict them
  // no longer being extracted as separate family documents.
  const realAttachments = (parsed.attachments ?? []).filter((a) => !a.related);
  return {
    kind: "email" as const,
    from: parsed.from?.text ?? null,
    to: Array.isArray(parsed.to) ? parsed.to.map((a) => a.text).join("; ") : parsed.to?.text ?? null,
    cc: Array.isArray(parsed.cc) ? parsed.cc.map((a) => a.text).join("; ") : parsed.cc?.text ?? null,
    date: parsed.date ? parsed.date.toISOString() : null,
    subject: parsed.subject ?? null,
    bodyHtml: parsed.html || null,
    bodyText: parsed.text || null,
    attachments: realAttachments.map((a) => ({ filename: nameEmbeddedEmailAttachment(a) ?? "attachment", size: a.size })),
  };
}

// Unlike mailparser, MsgReader's html field leaves cid: references
// unresolved (raw `src="cid:xxxx"`) rather than baking them into data:
// URIs — confirmed empirically against a real .msg with inline images (the
// html contained literal cid: srcs, not embedded image data). Resolved here
// by matching each cid: against the message's own attachments (by
// pidContentId, the MAPI Content-ID property) and substituting a real
// data: URI built from that attachment's own raw content — same visual
// result as the .eml case, just requiring an explicit step since this
// library doesn't do it automatically.
function resolveMsgInlineImages(
  html: string,
  attachments: Array<{ pidContentId?: string; attachMimeTag?: string }>,
  reader: { getAttachment(attach: unknown): { content: Uint8Array } },
): string {
  return html.replace(/cid:([^"'\s)]+)/gi, (match, cid: string) => {
    const attInfo = attachments.find((a) => a.pidContentId === cid);
    if (!attInfo) return match;
    try {
      const { content } = reader.getAttachment(attInfo);
      const mime = attInfo.attachMimeTag || "application/octet-stream";
      return `data:${mime};base64,${Buffer.from(content).toString("base64")}`;
    } catch {
      return match;
    }
  });
}

async function previewMsg(doc: DocumentRow) {
  const buf = await readFile(doc.stored_path);
  const reader = new MsgReader(toArrayBuffer(buf));
  const data = reader.getFileData();
  const recipients: Array<{ name?: string; email?: string; recipType?: string }> = data.recipients ?? [];
  const byType = (t: string) =>
    recipients
      .filter((r) => (r.recipType ?? "").toLowerCase() === t)
      .map((r) => r.name || r.email)
      .filter(Boolean)
      .join("; ") || null;

  // This library's actual field is `html` (raw bytes), not `bodyHtml` — the
  // previous code read a field that never exists on real output, so the
  // body silently never rendered for any .msg preview at all, independent
  // of the inline-image issue fixed alongside it here.
  const rawHtml: unknown = data.html;
  const htmlString = rawHtml instanceof Uint8Array ? Buffer.from(rawHtml).toString("utf-8") : (rawHtml as string | undefined) ?? null;
  const bodyHtml = htmlString ? resolveMsgInlineImages(htmlString, data.attachments ?? [], reader) : null;

  // PidTagAttachmentHidden — same "not a real attachment" signal as .eml's
  // `related` flag, see familyExtract.ts.
  const realAttachments = (data.attachments ?? []).filter((a: { attachmentHidden?: boolean }) => !a.attachmentHidden);

  return {
    kind: "email" as const,
    from: data.senderName ?? data.senderEmail ?? null,
    to: byType("to"),
    cc: byType("cc"),
    date: data.messageDeliveryTime ?? data.creationTime ?? null,
    subject: data.subject ?? null,
    bodyHtml,
    bodyText: data.body || null,
    // An embedded-message attachment has no `fileName` (that field is only
    // populated for a raw file attachment) — its display name lives in
    // `name` instead (e.g. "Please see attached documents"), same field
    // getAttachment() itself reads to build the ".msg"-suffixed filename
    // used for extraction. Without this fallback it showed as a bare,
    // unhelpful "attachment" in the preview's attachment list.
    attachments: realAttachments.map((a: { fileName?: string; name?: string; contentLength?: number }) => ({
      filename: a.fileName ?? a.name ?? "attachment",
      size: a.contentLength ?? null,
    })),
  };
}
