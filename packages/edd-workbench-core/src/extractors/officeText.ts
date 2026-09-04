import { parseOffice } from "officeparser";

export type OfficeTextFileType = "odt" | "ods" | "odp" | "epub" | "html" | "rtf";

export interface OfficeTextContent {
  title: string | null;
  author: string | null;
  subject: string | null;
  /** The document's own last-modified property (officeparser's ast.metadata.modified), NOT the uploaded file's browser-reported mtime. */
  modified: Date | null;
  text: string | null;
}

const NULL_CONTENT: OfficeTextContent = { title: null, author: null, subject: null, modified: null, text: null };

/**
 * Extracts title/author/subject/text from odt/ods/odp/epub/html/rtf via
 * officeparser, which normalizes metadata field names consistently across
 * every format it supports (confirmed empirically: `.metadata.title` /
 * `.author` / `.subject` regardless of the underlying format's own property
 * names). `fileType` must always be passed explicitly rather than relying
 * on officeparser's auto-detection — confirmed empirically that magic-byte-
 * less formats (html, and by extension any non-zip text format) fail to
 * auto-detect from a bare Buffer, so passing the hint unconditionally is
 * simpler and more robust than branching on which formats need it. ods
 * stays text-only here (no structured per-cell grid) — a deliberate,
 * acknowledged gap, not an oversight; a fast-follow if reviewers need
 * spreadsheet-shaped ODS review.
 */
export async function extractOfficeText(buffer: Buffer, fileType: OfficeTextFileType): Promise<OfficeTextContent> {
  try {
    const ast = await parseOffice(buffer, { fileType });
    const text = ast.toText();
    return {
      title: ast.metadata?.title ?? null,
      author: ast.metadata?.author ?? null,
      subject: ast.metadata?.subject ?? null,
      modified: ast.metadata?.modified ?? null,
      text: text.length > 0 ? text : null,
    };
  } catch {
    return NULL_CONTENT;
  }
}
