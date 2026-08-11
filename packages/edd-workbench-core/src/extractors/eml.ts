import { simpleParser } from "mailparser";

export interface EmlAttachment {
  filename: string;
  content: Buffer;
}

export interface EmlMetadata {
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: Date | null;
  bodyText: string | null;
  bodyHtml: string | null;
  attachmentFilenames: string[];
  /** Real attachment bytes, not just names — used to expand an email into child documents (see ingest.ts), one per attachment, each getting its own GUID/extraction. Separate from `attachmentFilenames` since that field is stored as-is in the `metadata` jsonb column and must stay JSON-serializable. */
  attachments: EmlAttachment[];
}

function addressText(value: { text: string } | { text: string }[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value.map((v) => v.text).join(", ") : value.text;
}

/** Parses a .eml (MIME) file's bytes into the fields the results table/viewer need. Pure — no I/O beyond the buffer it's given. */
export async function extractEmlMetadata(buffer: Buffer): Promise<EmlMetadata> {
  const parsed = await simpleParser(buffer);

  // mailparser sets `related: true` specifically when a part's Content-ID
  // is actually referenced by cid: in the HTML body — the reliable signal
  // for "this is an inline body image (a signature logo, an <img
  // src="cid:...">), not an evidentiary attachment" (more reliable than
  // contentDisposition === "inline" alone, which some senders set without
  // the part being cid-referenced anywhere). The parent .eml's own stored
  // bytes are an untouched copy, so the image still renders wherever the
  // parent itself is previewed; it just must never be staged as its own
  // child document.
  const realAttachments = parsed.attachments.filter((a) => !a.related);

  return {
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    subject: parsed.subject ?? null,
    date: parsed.date ?? null,
    bodyText: parsed.text ?? null,
    bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
    attachmentFilenames: realAttachments.map((a) => a.filename ?? "unnamed"),
    attachments: realAttachments.map((a) => ({ filename: a.filename ?? "unnamed", content: a.content })),
  };
}
