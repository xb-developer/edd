import mammoth from "mammoth";

export interface DocxContent {
  html: string | null;
}

const NULL_CONTENT: DocxContent = { html: null };

/**
 * Converts a .docx's body into HTML for inline rendering, stored in
 * metadata the same way eml/msg's bodyHtml/bodyText are — extracted once at
 * ingest time rather than re-parsed client-side. Returns null html rather
 * than throwing for anything that isn't a well-formed .docx, matching the
 * other extractors' graceful-degradation contract. The HTML is untrusted
 * third-party content and must be sanitized at render time, not here.
 */
export async function extractDocxContent(buffer: Buffer): Promise<DocxContent> {
  try {
    const result = await mammoth.convertToHtml({ buffer });
    return { html: result.value.length > 0 ? result.value : null };
  } catch {
    return NULL_CONTENT;
  }
}
