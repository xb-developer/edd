import WordExtractor from "word-extractor";
import { looksLikeRtf, looksLikeZip } from "./sniff.js";
import { extractDocxContent } from "./docx.js";
import { extractOfficeMetadata } from "./office.js";
import { extractOfficeText } from "./officeText.js";
import { extractDocSummaryInfo } from "./docSummaryInfo.js";

export type DetectedDocFormat = "docx" | "rtf" | "doc";

export interface DocExtractionResult {
  /** What the bytes actually are, sniffed from magic bytes rather than trusted from the upload-time `.doc` extension — real litigation exports routinely mislabel RTF or renamed-.docx content as `.doc`. */
  detectedFormat: DetectedDocFormat;
  html: string | null;
  text: string | null;
  title: string | null;
  author: string | null;
  subject: string | null;
  modified: Date | null;
}

const NULL_RESULT: DocExtractionResult = {
  detectedFormat: "doc",
  html: null,
  text: null,
  title: null,
  author: null,
  subject: null,
  modified: null,
};

/**
 * Extracts a legacy `.doc` upload's real content, after sniffing which of
 * three genuinely different formats it actually is: a renamed `.docx`
 * (zip-magic — delegated to the existing mammoth-based `extractDocxContent`
 * for body HTML, plus `extractOfficeMetadata` for title/author/subject/
 * modified, same pair a genuinely-named .docx upload uses — see ingest.ts's
 * own docx branch), real RTF (delegated to `extractOfficeText`, which
 * already returns both body text AND title/author/subject/modified in one
 * call), or genuine legacy OLE2/CFB binary `.doc` (body text via
 * `word-extractor`, which accepts a Buffer directly with no interop
 * workaround needed — its CJS export is a plain class, not the
 * default-wrapped shape that bit msg.ts — plus title/author/subject/
 * modified via `extractDocSummaryInfo`, since word-extractor's own public
 * API has no way to read that). The caller is expected to persist
 * `detectedFormat` back as the document's corrected `content_type_detected`
 * rather than trusting the upload-time extension.
 */
export async function extractDocContent(buffer: Buffer): Promise<DocExtractionResult> {
  if (looksLikeZip(buffer)) {
    const [docx, office] = await Promise.all([extractDocxContent(buffer), extractOfficeMetadata(buffer)]);
    return { detectedFormat: "docx", html: docx.html, text: null, title: office.title, author: office.author, subject: office.subject, modified: office.modified };
  }

  if (looksLikeRtf(buffer)) {
    const rtf = await extractOfficeText(buffer, "rtf");
    return { detectedFormat: "rtf", html: null, text: rtf.text, title: rtf.title, author: rtf.author, subject: rtf.subject, modified: rtf.modified };
  }

  try {
    const [document, summaryInfo] = await Promise.all([new WordExtractor().extract(buffer), extractDocSummaryInfo(buffer)]);
    const text = document.getBody();
    return {
      detectedFormat: "doc",
      html: null,
      text: text.length > 0 ? text : null,
      title: summaryInfo.title,
      author: summaryInfo.author,
      subject: summaryInfo.subject,
      modified: summaryInfo.modified,
    };
  } catch {
    return NULL_RESULT;
  }
}
