export type ContentType =
  | "docx"
  | "xlsx"
  | "pptx"
  | "eml"
  | "msg"
  | "pdf"
  | "image"
  | "text"
  | "doc"
  | "rtf"
  | "odt"
  | "ods"
  | "odp"
  | "epub"
  | "html"
  | "csv"
  | "tiff"
  | "pst"
  | "zip"
  | "7z"
  | "mbox"
  | "other";

/**
 * Extension-based content-type detection, shared between the server (used
 * once at upload time, on the client-supplied filename) and the worker
 * (used again when expanding an email/msg's attachments into their own
 * child documents — see ingest.ts — since a freshly-discovered attachment
 * needs the same classification an originally-uploaded file gets). Kept in
 * one place rather than duplicated so the two call sites can't drift.
 */
export function detectContentType(filename: string): ContentType {
  switch (filename.toLowerCase().split(".").pop() ?? "") {
    case "docx":
    case "docm":
    case "dotm":
      return "docx";
    case "xlsx":
    case "xls":
    case "xla":
    case "xlsm":
    case "xltx":
      return "xlsx";
    case "pptx":
      return "pptx";
    case "eml":
      return "eml";
    case "msg":
      return "msg";
    case "pdf":
      return "pdf";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "bmp":
      return "image";
    case "txt":
      return "text";
    case "doc":
      // Extension-time guess only — real litigation exports routinely
      // mislabel RTF or a renamed .docx as .doc. Corrected at ingest time
      // once the worker sniffs the actual bytes (see doc.ts).
      return "doc";
    case "rtf":
      return "rtf";
    case "odt":
      return "odt";
    case "ods":
      return "ods";
    case "odp":
      return "odp";
    case "epub":
      return "epub";
    case "html":
    case "htm":
      return "html";
    case "csv":
      return "csv";
    case "tiff":
    case "tif":
      return "tiff";
    case "pst":
    case "ost":
      // Same precedent as .xls folding into "xlsx": one extractor
      // (extractors/pst.ts's iteratePstMessages), one enum value — an
      // offline-cached .ost (an OST is byte-format-compatible with a PST
      // for pst-extractor's purposes) needs no separate branch anywhere
      // downstream.
      return "pst";
    case "zip":
      return "zip";
    case "7z":
      return "7z";
    case "mbox":
      return "mbox";
    case "ppt":
    case "pps":
    case "pot":
      // Legacy binary PowerPoint: deliberately unsupported, not silently
      // unconsidered — the only maintained-ish reader (the `ppt` npm
      // package) is effectively abandoned (stuck at 0.0.2 since 2014) and
      // needs a permanent process-wide monkeypatch of the shared `cfb`
      // dependency to even load, with the same fragile CJS-export shape
      // that caused msg.ts's real production bug. Not worth the risk for a
      // format with no viable reader.
      return "other";
    case "dwg":
      // No pure-JS reader exists — genuine CAD parsing needs a paid SDK.
      return "other";
    case "mpp":
      // No pure-JS reader exists without pulling in an LGPL-licensed library.
      return "other";
    default:
      return "other";
  }
}

/**
 * Real HTTP Content-Type for an S3 upload, by filename extension — a
 * separate, finer-grained mapping from detectContentType's own internal
 * ContentType enum (which deliberately folds every image extension into
 * one "image" category, and doesn't need to distinguish .xls from .xlsx,
 * etc.) because the S3 object's Content-Type header is what a browser
 * actually uses to decide how to render a response — e.g. Chrome's native
 * PDF viewer refuses to render an octet-stream response inline, so this
 * needs real MIME precision, not the coarser internal category.
 */
export function mimeTypeFor(filename: string): string {
  switch (filename.toLowerCase().split(".").pop() ?? "") {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "docx":
    case "docm":
    case "dotm":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
    case "xlsm":
    case "xltx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xls":
    case "xla":
      return "application/vnd.ms-excel";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "eml":
      return "message/rfc822";
    case "msg":
      return "application/vnd.ms-outlook";
    case "txt":
      return "text/plain";
    case "doc":
      return "application/msword";
    case "rtf":
      return "application/rtf";
    case "odt":
      return "application/vnd.oasis.opendocument.text";
    case "ods":
      return "application/vnd.oasis.opendocument.spreadsheet";
    case "odp":
      return "application/vnd.oasis.opendocument.presentation";
    case "epub":
      return "application/epub+zip";
    case "html":
    case "htm":
      return "text/html";
    case "csv":
      return "text/csv";
    case "tiff":
    case "tif":
      return "image/tiff";
    case "zip":
      return "application/zip";
    case "7z":
      return "application/x-7z-compressed";
    default:
      return "application/octet-stream";
  }
}
