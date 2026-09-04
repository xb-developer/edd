import { simpleParser } from "mailparser";

export interface EmlAttachment {
  filename: string;
  content: Buffer;
}

export interface EmlMetadata {
  /** The sender's display name, or their address if no name was given (see senderDisplay) — used directly as the document's `author`. */
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

/**
 * The sender's display name, or their address if no name was given — NOT
 * the combined "Name <address>" form `addressText` produces (used for
 * `author`, where a reviewer wants "Jane Reviewer", not "Jane Reviewer
 * <jane@example.com>"). mailparser's `AddressObject.value` array carries
 * name/address as separate fields per parsed address, unlike `.text`
 * (which is already the pre-rendered combined string) — this reads the
 * first address's own fields directly instead.
 */
function senderDisplay(
  value: { value: { name?: string; address?: string }[] } | { value: { name?: string; address?: string }[] }[] | undefined,
): string | null {
  if (!value) return null;
  const addressObject = Array.isArray(value) ? value[0] : value;
  const first = addressObject?.value?.[0];
  if (!first) return null;
  return first.name || first.address || null;
}

/**
 * A real, plain "unnamed" (no extension at all) is exactly what a forwarded
 * email attached without an explicit filename comes back as from
 * mailparser — confirmed against a real Outlook-forwarded message, not a
 * hypothetical: Outlook routinely sends a `message/rfc822` part with only
 * creation-date/modification-date on its Content-Disposition, no filename
 * param at all. Left as bare "unnamed", ingest.ts's own
 * `detectContentType` (extension-based) has nothing to key off and files
 * it under "other" — a real dead end for attachment recursion, since
 * "other" never gets parsed or expanded. A `message/rfc822` part is
 * unambiguously a real email regardless of what (if anything) its own
 * filename param says, so it gets a real ".eml" extension here — the one
 * content-type this actually matters for, since it's the one that must
 * recurse.
 */
function filenameFor(attachment: { filename?: string; contentType: string }): string {
  if (attachment.filename) return attachment.filename;
  return attachment.contentType === "message/rfc822" ? "unnamed.eml" : "unnamed";
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
    from: senderDisplay(parsed.from),
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    subject: parsed.subject ?? null,
    date: parsed.date ?? null,
    bodyText: parsed.text ?? null,
    bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
    attachmentFilenames: realAttachments.map(filenameFor),
    attachments: realAttachments.map((a) => ({ filename: filenameFor(a), content: a.content })),
  };
}
