import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

export interface OfficeMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  /** The document's own last-modified property (docProps/core.xml's dcterms:modified), NOT the uploaded file's browser-reported mtime. */
  modified: Date | null;
}

const NULL_METADATA: OfficeMetadata = { title: null, author: null, subject: null, modified: null };

const parser = new XMLParser({ removeNSPrefix: true });

/**
 * Pulls title/author/subject/modified out of a .docx/.xlsx/.pptx's
 * docProps/core.xml (the same zip-of-XML structure for all three Office
 * Open XML formats). Returns nulls rather than throwing for anything that
 * isn't a well-formed Office file — a single corrupt/unsupported upload
 * must never take down the rest of an ingest batch.
 */
export async function extractOfficeMetadata(buffer: Buffer): Promise<OfficeMetadata> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const coreXmlFile = zip.file("docProps/core.xml");
    if (!coreXmlFile) return NULL_METADATA;

    const xml = await coreXmlFile.async("string");
    const parsed = parser.parse(xml);
    const core = parsed.coreProperties ?? {};
    // dcterms:modified is a W3CDTF (ISO 8601) string once the xsi:type
    // attribute is dropped (ignoreAttributes defaults to true, and isn't
    // overridden here) — parse it, but fall back to null on a genuinely
    // malformed date rather than storing an Invalid Date.
    const modified = core.modified ? new Date(core.modified) : null;

    return {
      title: core.title ?? null,
      author: core.creator ?? null,
      subject: core.subject ?? null,
      modified: modified && !isNaN(modified.getTime()) ? modified : null,
    };
  } catch {
    return NULL_METADATA;
  }
}
