import { parseOffice } from "officeparser";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

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

const epubXmlParser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: "" });

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as Record<string, unknown>)["#text"] === "string") {
    return (value as Record<string, string>)["#text"];
  }
  return undefined;
}

/**
 * Reads a real EPUB's own `dcterms:modified` OPF meta-refinement directly —
 * a workaround for a confirmed gap in the officeparser dependency itself:
 * its EpubParser.js never populates `ast.metadata.modified` for epub at
 * all (only `dc:date` into a separate, unread `metadata.created` field),
 * despite officeparser's own type declaration documenting that epub SHOULD
 * set `modified` from exactly this property (see officeText.test.ts's own
 * regression/canary test for that gap, and this file's own comment above
 * the fallback call site). Falls back to `dc:date` (the same property
 * dc:date maps to for odt/ods/odp's own `modified`) only if no explicit
 * dcterms:modified refinement exists. Returns null (never throws) for
 * anything malformed, matching every other extractor's own contract — this
 * is best-effort defense-in-depth for a dependency's own gap, not a
 * required part of a well-formed EPUB.
 */
async function extractEpubModifiedDate(buffer: Buffer): Promise<Date | null> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) return null;
    const containerXml = epubXmlParser.parse(await containerFile.async("string"));
    const rootfile = containerXml.container?.rootfiles?.rootfile;
    // Attributes (unlike mixed element text) are always plain strings under
    // fast-xml-parser's ignoreAttributes:false — no textOf() needed here.
    const opfPath = (Array.isArray(rootfile) ? rootfile[0] : rootfile)?.["full-path"];
    if (typeof opfPath !== "string") return null;

    const opfFile = zip.file(opfPath);
    if (!opfFile) return null;
    const opfXml = epubXmlParser.parse(await opfFile.async("string"));
    const metadata = opfXml.package?.metadata;
    if (!metadata) return null;

    const metaTags: unknown[] = Array.isArray(metadata.meta) ? metadata.meta : metadata.meta ? [metadata.meta] : [];
    const modifiedTag = metaTags.find((m) => (m as Record<string, unknown>)?.property === "dcterms:modified");
    const raw = textOf(modifiedTag) ?? textOf(metadata.date);
    if (!raw) return null;

    const date = new Date(raw);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

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
    // officeparser's own EpubParser.js never sets ast.metadata.modified for
    // epub (a confirmed gap in that dependency, not this wiring) — read it
    // ourselves directly from the OPF's dcterms:modified in that one case.
    const modified = ast.metadata?.modified ?? (fileType === "epub" ? await extractEpubModifiedDate(buffer) : null);
    return {
      title: ast.metadata?.title ?? null,
      author: ast.metadata?.author ?? null,
      subject: ast.metadata?.subject ?? null,
      modified: modified ?? null,
      text: text.length > 0 ? text : null,
    };
  } catch {
    return NULL_CONTENT;
  }
}
