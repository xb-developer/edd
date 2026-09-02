import { htmlToText } from "html-to-text";

// A plain string, not the ContentType union — matches ingest.ts's own
// DocumentRow shape (content_type_detected: string), which never imports/
// casts to that type either; a DB enum column read back via `pg` is just
// a string at the type level here.
//
// Mirrors the Electron POC's own embeddingEligibility.ts concept — content
// types ingest.ts never gives real prose text worth embedding at all:
// spreadsheets tokenize far denser than prose (a real contributor to slow/
// pathological embedding runs in the POC), and pptx has no stored text at
// all (the client renders the raw file directly — see ingest.ts's pptx
// branch never writing `metadata`).
const EXCLUDED_CONTENT_TYPES = new Set(["xlsx", "csv", "pptx"]);

/**
 * Resolves the real embeddable plain text for a document, or null if this
 * document is either excluded by content type or genuinely has no text
 * (whatever `metadata` holds was empty/absent) — the embedding queue
 * handler uses null to mark embedding_status = 'excluded' without ever
 * calling the model.
 *
 * Every content type stores its extracted content differently in
 * `metadata` (see ingest.ts's own per-branch UPDATE statements) — this is
 * the one place that knows how to get plain text back out of each shape.
 * Preference order: a real plain-text field first (bodyText/text), HTML
 * stripped as a fallback (docx/doc sometimes only ever store `html`, no
 * separate plain-text field at all).
 */
export function resolveEmbeddableText(contentType: string, metadata: Record<string, unknown> | null): string | null {
  if (EXCLUDED_CONTENT_TYPES.has(contentType)) return null;
  if (!metadata) return null;

  const bodyText = metadata.bodyText;
  if (typeof bodyText === "string" && bodyText.trim().length > 0) return bodyText.trim();

  const text = metadata.text;
  if (typeof text === "string" && text.trim().length > 0) return text.trim();

  const html = metadata.html;
  if (typeof html === "string") {
    const stripped = htmlToText(html, { wordwrap: false }).trim();
    if (stripped.length > 0) return stripped;
  }

  return null;
}
