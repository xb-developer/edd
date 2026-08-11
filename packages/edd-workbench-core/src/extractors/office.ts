import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

export interface OfficeMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
}

const NULL_METADATA: OfficeMetadata = { title: null, author: null, subject: null };

const parser = new XMLParser({ removeNSPrefix: true });

/**
 * Pulls title/author/subject out of a .docx/.xlsx/.pptx's docProps/core.xml
 * (the same zip-of-XML structure for all three Office Open XML formats).
 * Returns nulls rather than throwing for anything that isn't a well-formed
 * Office file — a single corrupt/unsupported upload must never take down
 * the rest of an ingest batch.
 */
export async function extractOfficeMetadata(buffer: Buffer): Promise<OfficeMetadata> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const coreXmlFile = zip.file("docProps/core.xml");
    if (!coreXmlFile) return NULL_METADATA;

    const xml = await coreXmlFile.async("string");
    const parsed = parser.parse(xml);
    const core = parsed.coreProperties ?? {};

    return {
      title: core.title ?? null,
      author: core.creator ?? null,
      subject: core.subject ?? null,
    };
  } catch {
    return NULL_METADATA;
  }
}
