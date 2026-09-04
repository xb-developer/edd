import * as MsgReaderModule from "@kenjiuno/msgreader";
import type { FieldsData, RawProp } from "@kenjiuno/msgreader";
import { htmlToText } from "html-to-text";
import iconv from "iconv-lite";

// @kenjiuno/msgreader is CJS with `exports.default = <ctor>`. Under
// Vitest/esbuild's bundler-style interop, a default import unwraps that one
// level and MsgReaderModule.default is already the constructor. Under
// plain Node's native ESM loader there's no such unwrapping — a CJS
// module's ESM default is the whole `module.exports` object, so
// MsgReaderModule.default is that object again, and the real constructor
// is one level deeper at MsgReaderModule.default.default. This bit us for
// real: extraction silently returned nulls for every real .msg file when
// the worker ran outside Vitest (`new MsgReader(...)` threw "is not a
// constructor", swallowed by the catch below), even though the Vitest
// suite passed throughout. Handling both shapes here is the fix, not
// picking one loader's behavior and hoping.
const MsgReaderCtor: typeof import("@kenjiuno/msgreader").default =
  typeof (MsgReaderModule as unknown as { default: unknown }).default === "function"
    ? (MsgReaderModule as unknown as { default: typeof import("@kenjiuno/msgreader").default }).default
    : (MsgReaderModule as unknown as { default: { default: typeof import("@kenjiuno/msgreader").default } }).default.default;

export interface MsgAttachment {
  filename: string;
  content: Buffer;
}

export interface MsgMetadata {
  /** The sender's display name, or their address if no name was given (see senderDisplay) — used directly as the document's `author`. */
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: Date | null;
  bodyText: string | null;
  attachmentFilenames: string[];
  /** Real attachment bytes, not just names — used to expand a .msg into child documents (see ingest.ts). Separate from `attachmentFilenames` since that field is stored as-is in the `metadata` jsonb column and must stay JSON-serializable. */
  attachments: MsgAttachment[];
}

const NULL_METADATA: MsgMetadata = {
  from: null,
  to: null,
  cc: null,
  subject: null,
  date: null,
  bodyText: null,
  attachmentFilenames: [],
  attachments: [],
};

/**
 * A message sent through Exchange stores a recipient/sender's real address
 * as an X.500 directory name (e.g.
 * `/o=ExchangeLabs/ou=Exchange Administrative Group (xxx)/cn=Recipients/cn=xxx`)
 * in the plain `email`/`senderEmail` field whenever `addressType`/
 * `senderAddressType` is `'EX'` — that string is never a real address, only
 * ever the display ("Active Directory") name is human-meaningful there. The
 * real SMTP address, when Exchange has resolved and attached one, lives in
 * the separate `smtpAddress`/`senderSmtpAddress` field instead (see this
 * library's own MsgReader.d.ts comments on PidTagSmtpAddress/
 * PidTagSenderSmtpAddress). Preferring `smtpAddress` first, then `email`
 * only when it actually looks like an address (contains "@" — true for
 * `addressType === 'SMTP'`, never true for an EX distinguished name), then
 * falling back to the display name only when no address at all is
 * available, is what actually shows a usable email instead of an AD name.
 */
export function resolveAddress(name: string | undefined, email: string | undefined, smtpAddress: string | undefined): string | null {
  const realEmail = smtpAddress || (email && email.includes("@") ? email : undefined);
  if (name && realEmail) return `${name} <${realEmail}>`;
  if (realEmail) return realEmail;
  if (name) return name;
  return null;
}

/**
 * The sender's display name, or their address if no name was given — NOT
 * the combined "name <address>" form `resolveAddress` produces (used for
 * `to`/`cc`, where that combined form is the conventional email-client
 * display). Used for `author`, where a reviewer wants "Jane Reviewer", not
 * "Jane Reviewer <jane@example.com>". Same real-address preference as
 * `resolveAddress` (smtpAddress, then a real-looking `email`), just
 * returning name-or-address instead of combining them.
 */
export function senderDisplay(name: string | undefined, email: string | undefined, smtpAddress: string | undefined): string | null {
  if (name) return name;
  const realEmail = smtpAddress || (email && email.includes("@") ? email : undefined);
  return realEmail ?? null;
}

// PidTagBodyHtml as a hex-encoded MAPI property tag: 1013 (the property)
// + 0102 (PT_BINARY). msgreader's own automatic decoding only populates
// `data.bodyHtml` for the PT_UNICODE/PT_STRING8 variants of this property —
// confirmed against a real fixture (a message composed with an HTML
// signature block and inline images) where PidTagBodyHtml is PT_BINARY and
// `data.bodyHtml`/`data.compressedRtf` both come back undefined even though
// the real HTML body is sitting right there in rawProps. Needs
// `parserConfig.includeRawProps` set before `getFileData()` is called.
const PIDTAG_BODY_HTML_BINARY = "10130102";

/**
 * Decodes a raw PidTagBodyHtml PT_BINARY property, honoring the HTML's own
 * declared charset (its <meta charset=...> tag) rather than assuming UTF-8
 * — Outlook commonly writes this as Windows-1252 (or another single-byte
 * codepage), not UTF-8, and blindly UTF-8-decoding mangles any non-ASCII
 * character in the body (confirmed on the real fixture above: an em-dash
 * came back as U+FFFD). Reading the declared charset first via a 'latin1'
 * pass (safe here — every byte maps 1:1 to a codepoint for the ASCII-range
 * meta tag itself, regardless of the real encoding) and only reaching for
 * iconv-lite when that charset isn't already UTF-8 keeps the common case
 * cheap.
 */
function decodeRawBodyHtml(rawProps: RawProp[] | undefined): string | null {
  const prop = (rawProps ?? []).find((p) => p.propertyTag === PIDTAG_BODY_HTML_BINARY);
  if (!prop || !(prop.value instanceof Uint8Array)) return null;
  const bytes = Buffer.from(prop.value);
  const charset = bytes
    .toString("latin1")
    .match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]
    ?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8" && iconv.encodingExists(charset)) {
    return iconv.decode(bytes, charset);
  }
  return bytes.toString("utf-8");
}

function recipientsOfType(recipients: FieldsData[] | undefined, type: "to" | "cc"): string | null {
  const matches = (recipients ?? [])
    .filter((r) => r.recipType === type)
    .map((r) => resolveAddress(r.name, r.email, r.smtpAddress))
    .filter((v): v is string => Boolean(v));
  return matches.length > 0 ? matches.join(", ") : null;
}

/**
 * Extracts sender/recipients/subject/body/attachments from a real Outlook
 * .msg (OLE/Compound-File-Binary) file. Returns nulls/empties rather than
 * throwing for anything that isn't a well-formed .msg — same graceful-
 * degradation contract as the eml/office extractors. Note: some older
 * Outlook messages store their body only as compressed RTF, which this
 * doesn't decode — those still surface as bodyText: null (a known
 * limitation, not a bug — see the build plan's ingest pipeline notes).
 * A message with NO plain-text body but a real HTML one (confirmed common:
 * any message composed with formatting/a signature/inline images) falls
 * back to htmlToText-stripping the HTML body instead of also giving up —
 * see decodeRawBodyHtml's own comment for why that HTML often isn't even
 * where msgreader's own automatic decoding looks for it.
 */
export async function extractMsgMetadata(buffer: Buffer): Promise<MsgMetadata> {
  try {
    // DataView, not ArrayBuffer — Buffer.buffer is typed ArrayBufferLike
    // (which includes SharedArrayBuffer), so it isn't directly assignable to
    // MsgReader's ArrayBuffer|DataView constructor param; DataView's own
    // constructor accepts ArrayBufferLike directly, and needs no byte copy.
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const reader = new MsgReaderCtor(view);
    // Needed for decodeRawBodyHtml's own rawProps lookup below — set
    // before getFileData() runs, since that's when parsing actually
    // happens (parserConfig isn't consulted retroactively).
    reader.parserConfig = { includeRawProps: true };
    const data = reader.getFileData();
    if (data.error) return NULL_METADATA;

    const from = senderDisplay(data.senderName, data.senderEmail, data.senderSmtpAddress);

    const dateSource = data.messageDeliveryTime ?? data.clientSubmitTime ?? data.creationTime ?? null;

    // Attachments Outlook marks as "hidden" (PidTagAttachmentHidden) are
    // inline body images referenced by cid: in the HTML body (a signature
    // logo, an embedded photo) — not evidentiary attachments. The parent
    // .msg's own stored bytes are an untouched copy, so the image still
    // renders wherever the parent itself is previewed; it just must never
    // be staged as its own child document (confirmed on a real test .msg:
    // every inline signature image had this flag set, the genuine
    // attachments didn't).
    const attachments: MsgAttachment[] = [];
    for (const attachmentField of data.attachments ?? []) {
      if (attachmentField.attachmentHidden) continue;
      try {
        const attachment = reader.getAttachment(attachmentField);
        attachments.push({ filename: attachment.fileName ?? "unnamed", content: Buffer.from(attachment.content) });
      } catch {
        // One unreadable attachment must never lose the rest of the
        // message's metadata or its other attachments. Note: an embedded
        // .msg-within-.msg attachment (`innerMsgContent: true`) is NOT such
        // a case — getAttachment really does reconstruct it into a genuine
        // CFBF byte buffer (confirmed against a real fixture with one),
        // which ingest.ts's expandAttachments then recurses into like any
        // other real attachment. This catch is for genuinely corrupt/
        // unreadable attachment data, not a known unsupported format.
      }
    }

    let bodyText = data.body ?? null;
    if (!bodyText) {
      const html = data.bodyHtml ?? decodeRawBodyHtml(data.rawProps);
      if (html) bodyText = htmlToText(html, { wordwrap: false }).trim() || null;
    }

    return {
      from,
      to: recipientsOfType(data.recipients, "to"),
      cc: recipientsOfType(data.recipients, "cc"),
      subject: data.subject ?? null,
      date: dateSource ? new Date(dateSource) : null,
      bodyText,
      attachmentFilenames: attachments.map((a) => a.filename),
      attachments,
    };
  } catch {
    return NULL_METADATA;
  }
}
