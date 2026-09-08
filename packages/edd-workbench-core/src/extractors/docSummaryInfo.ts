// word-extractor has no public API for a legacy .doc's OLE "SummaryInformation"
// property stream (Title/Author/Subject/dates) — its own documented methods
// only ever return body/footnote/header/endnote/annotation TEXT (see its
// README). It DOES already correctly implement OLE compound-file parsing
// internally (MSAT/SAT/SSAT/directory-tree/short-stream handling) to find
// the "WordDocument" stream — reused here via a deep import of its
// internal (undocumented, unexported-in-package.json-but-not-blocked-by-an-
// exports-map) lib/ modules, rather than re-implementing OLE compound-file
// parsing from scratch or adding a whole new dependency for one stream.
// Pinned to word-extractor@1.0.4's current lib/ shape — a future major bump
// of this dependency could silently break this file without breaking
// word-extractor's own (unrelated) body-text extraction, since this reaches
// past its public API entirely.
import { createRequire } from "node:module";
// Same CJS-interop pattern as pdfText.ts's own require.resolve() —
// word-extractor's lib/ modules are plain CommonJS with no ESM entry point.
const require = createRequire(import.meta.url);
const BufferReader = require("word-extractor/lib/buffer-reader.js");
const OleCompoundDoc = require("word-extractor/lib/ole-compound-doc.js");

export interface DocSummaryInfo {
  title: string | null;
  author: string | null;
  subject: string | null;
  /** LastSaveDateTime (property 13), falling back to CreateDateTime (property 12) if unset — matches OfficeMetadata's `modified` field's own semantics. */
  modified: Date | null;
}

const NULL_SUMMARY_INFO: DocSummaryInfo = { title: null, author: null, subject: null, modified: null };

// OLE property set stream (MS-OLEPS) type codes this reader understands —
// the only ones the SummaryInformation property set actually uses for the
// fields read here.
const VT_LPSTR = 30;
const VT_LPWSTR = 31;
const VT_FILETIME = 64;

const PIDSI_TITLE = 2;
const PIDSI_SUBJECT = 3;
const PIDSI_AUTHOR = 4;
const PIDSI_CREATE_DTM = 12;
const PIDSI_LASTSAVE_DTM = 13;

// FILETIME is 100ns ticks since 1601-01-01 — this is the ms offset between
// that epoch and Unix's 1970-01-01, used to convert.
const FILETIME_EPOCH_OFFSET_MS = 11644473600000;

function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Parses a raw OLE PropertySetStream buffer (MS-OLEPS §2.21) into a
 * {propertyId -> value} map, for exactly the value types SummaryInformation
 * actually uses (VT_LPSTR/VT_LPWSTR/VT_FILETIME) — anything else is skipped
 * rather than decoded, since nothing read here needs it.
 */
function parsePropertySet(buffer: Buffer): Map<number, string | Date> {
  const values = new Map<number, string | Date>();
  // Header: byteOrder(2) version(2) osVersion(4) clsid(16) numPropertySets(4)
  const numPropertySets = buffer.readUInt32LE(24);
  if (numPropertySets < 1) return values;
  // First (and, for SummaryInformation, only relevant) property set:
  // fmtid(16) offset(4), starting right after the 28-byte header.
  const setOffset = buffer.readUInt32LE(28 + 16);

  const numProperties = buffer.readUInt32LE(setOffset + 4);
  for (let i = 0; i < numProperties; i++) {
    const entryOffset = setOffset + 8 + i * 8;
    if (entryOffset + 8 > buffer.length) break;
    const propertyId = buffer.readUInt32LE(entryOffset);
    const valueOffset = setOffset + buffer.readUInt32LE(entryOffset + 4);
    if (valueOffset + 4 > buffer.length) continue;

    const type = buffer.readUInt32LE(valueOffset);
    if (type === VT_LPSTR) {
      const size = buffer.readUInt32LE(valueOffset + 4);
      const start = valueOffset + 8;
      if (start + size > buffer.length) continue;
      // size includes the trailing null byte(s) — drop them and any
      // further padding-driven trailing NULs before decoding.
      const raw = buffer.toString("latin1", start, start + size).replace(/\0+$/, "");
      if (raw) values.set(propertyId, raw);
    } else if (type === VT_LPWSTR) {
      const size = buffer.readUInt32LE(valueOffset + 4);
      const start = valueOffset + 8;
      const byteLength = size * 2;
      if (start + byteLength > buffer.length) continue;
      const raw = buffer.toString("utf16le", start, start + byteLength).replace(/\0+$/, "");
      if (raw) values.set(propertyId, raw);
    } else if (type === VT_FILETIME) {
      if (valueOffset + 12 > buffer.length) continue;
      const low = buffer.readUInt32LE(valueOffset + 4);
      const high = buffer.readUInt32LE(valueOffset + 8);
      const ticks100ns = high * 2 ** 32 + low;
      const ms = ticks100ns / 10000 - FILETIME_EPOCH_OFFSET_MS;
      const date = new Date(ms);
      if (!isNaN(date.getTime()) && date.getUTCFullYear() > 1601) values.set(propertyId, date);
    }
  }
  return values;
}

/**
 * Reads a legacy binary .doc's "SummaryInformation" OLE stream
 * (Title/Author/Subject/dates) — the equivalent of docx's docProps/core.xml
 * (see office.ts) for the pre-2007 binary format. Returns nulls (never
 * throws) for anything unreadable — a corrupt/unusual .doc, or one with no
 * summary-info stream at all, matching this codebase's other extractors'
 * defensive contract.
 */
export async function extractDocSummaryInfo(buffer: Buffer): Promise<DocSummaryInfo> {
  try {
    const reader = new BufferReader(buffer);
    await reader.open();
    const doc = new OleCompoundDoc(reader);
    await doc.read();
    // The leading \x05 is part of the real OLE directory-entry name (a
    // convention marking these as "special"/hidden streams), not a typo —
    // required for the lookup to actually match. Built via fromCharCode
    // rather than embedding the raw control byte directly in this source
    // file, which editors/linters can silently mangle.
    const stream = doc.stream(String.fromCharCode(5) + "SummaryInformation");
    const streamBuffer = await readStreamToBuffer(stream);
    if (streamBuffer.length === 0) return NULL_SUMMARY_INFO;

    const values = parsePropertySet(streamBuffer);
    const title = values.get(PIDSI_TITLE);
    const author = values.get(PIDSI_AUTHOR);
    const subject = values.get(PIDSI_SUBJECT);
    const modified = values.get(PIDSI_LASTSAVE_DTM) ?? values.get(PIDSI_CREATE_DTM);

    return {
      title: typeof title === "string" ? title : null,
      author: typeof author === "string" ? author : null,
      subject: typeof subject === "string" ? subject : null,
      modified: modified instanceof Date ? modified : null,
    };
  } catch {
    return NULL_SUMMARY_INFO;
  }
}
