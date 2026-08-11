import WordExtractor from "word-extractor";
import { looksLikeRtf, looksLikeZip } from "./sniff.js";
import { extractDocxContent } from "./docx.js";
import { extractOfficeText } from "./officeText.js";

export type DetectedDocFormat = "docx" | "rtf" | "doc";

export interface DocExtractionResult {
  /** What the bytes actually are, sniffed from magic bytes rather than trusted from the upload-time `.doc` extension — real litigation exports routinely mislabel RTF or renamed-.docx content as `.doc`. */
  detectedFormat: DetectedDocFormat;
  html: string | null;
  text: string | null;
}

const NULL_RESULT: DocExtractionResult = { detectedFormat: "doc", html: null, text: null };

/**
 * Extracts a legacy `.doc` upload's real content, after sniffing which of
 * three genuinely different formats it actually is: a renamed `.docx`
 * (zip-magic — delegated to the existing mammoth-based `extractDocxContent`,
 * not `word-extractor`, whose own zip-input path assumes ODF rather than
 * OOXML and would mis-parse or throw on this case), real RTF (delegated to
 * `extractOfficeText`), or genuine legacy OLE2/CFB binary `.doc` (handled
 * here via `word-extractor`, which accepts a Buffer directly with no
 * interop workaround needed — its CJS export is a plain class, not the
 * default-wrapped shape that bit msg.ts). The caller is expected to persist
 * `detectedFormat` back as the document's corrected `content_type_detected`
 * rather than trusting the upload-time extension.
 */
export async function extractDocContent(buffer: Buffer): Promise<DocExtractionResult> {
  if (looksLikeZip(buffer)) {
    const docx = await extractDocxContent(buffer);
    return { detectedFormat: "docx", html: docx.html, text: null };
  }

  if (looksLikeRtf(buffer)) {
    const rtf = await extractOfficeText(buffer, "rtf");
    return { detectedFormat: "rtf", html: null, text: rtf.text };
  }

  try {
    const document = await new WordExtractor().extract(buffer);
    const text = document.getBody();
    return { detectedFormat: "doc", html: null, text: text.length > 0 ? text : null };
  } catch {
    return NULL_RESULT;
  }
}
