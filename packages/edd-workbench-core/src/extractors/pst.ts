import { PSTFile, PSTFolder, PSTMessage, PSTAttachment } from "pst-extractor";

export interface PstAttachment {
  filename: string;
  content: Buffer;
}

export interface PstMessageRecord {
  /**
   * Slash-joined folder names from just below the PST's own root (e.g.
   * "Top of Personal Folders/lokay-m/Inbox") — deliberately includes
   * Deleted Items, since nothing gets silently dropped from a preservation
   * standpoint, though this lets a reviewer filter on where a message
   * lived later.
   */
  folderPath: string;
  /** The raw PR_MESSAGE_CLASS value ("IPM.Note", "IPM.Note.SMIME.MultipartSigned", ...) — every yielded record already passed the IPM.Note* filter below, but ingest.ts's metadata keeps this around verbatim rather than re-deriving it. */
  messageClass: string;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: Date | null;
  bodyText: string | null;
  bodyHtml: string | null;
  /** The real PR_MESSAGE_SIZE property (`message.messageSize`, a `long`) — the sum, in bytes, of every property on the message object, not an approximation derived from body/attachment lengths. */
  sizeBytes: number;
  attachmentFilenames: string[];
  /** Real attachment bytes, not just names — same shape/rationale as msg.ts's/eml.ts's own `attachments` field: used to expand a PST message into child documents via ingest.ts's existing expandAttachments(), completely unmodified. Only BY_VALUE attachments end up here; an EMBEDDED attachment (a forwarded original message) is recursed into as its own yielded PstMessageRecord instead — see messagesFromItem below. */
  attachments: PstAttachment[];
}

// A forwarded-message-as-attachment chain has no natural termination in a
// hostile/corrupt file (a message embedding itself, or a very deep
// forward-of-a-forward-of-a-forward chain) — capped the same way any other
// self-referential-archive risk would need capping.
const MAX_EMBEDDED_DEPTH = 5;

/**
 * A real (legacy, non-Unicode) PST can store a string property in a
 * fixed-length or NUL-terminated field; pst-extractor's own
 * `PSTUtil.createJavascriptString` strips a trailing NUL for its UTF-16LE
 * branch but not for its iconv-lite-codepage branch, so a genuinely
 * NUL-containing decoded string can still reach this extractor's output.
 * Postgres `text` columns reject a raw NUL byte outright regardless of
 * encoding (confirmed for real against a corrupt-file error message
 * elsewhere in this PST pipeline — see ingest.ts's own
 * `sanitizeForPostgresText`) — stripped here, at the extraction boundary,
 * so every string this module hands back is safe to store directly in a
 * raw column (subject/author/original_filename), not just inside a
 * `JSON.stringify`'d blob (which already escapes control characters on its
 * own).
 */
function stripNulBytes(value: string): string {
  return value.replace(new RegExp(String.fromCharCode(0), "g"), "");
}

function combineNameAndAddress(name: string, address: string): string | null {
  const trimmedName = stripNulBytes(name).trim();
  const trimmedAddress = stripNulBytes(address).trim();
  if (trimmedName && trimmedAddress) return `${trimmedName} <${trimmedAddress}>`;
  return trimmedName || trimmedAddress || null;
}

/** Prefers the actual sender; falls back to "sent representing" (relevant for e.g. delegate-sent mail) — mirrors msg.ts's own from-field fallback shape. */
function messageFrom(message: PSTMessage): string | null {
  return (
    combineNameAndAddress(message.senderName, message.senderEmailAddress) ??
    combineNameAndAddress(message.sentRepresentingName, message.sentRepresentingEmailAddress)
  );
}

function messageDate(message: PSTMessage): Date | null {
  return message.clientSubmitTime ?? message.messageDeliveryTime ?? message.creationTime ?? null;
}

/**
 * Reads a BY_VALUE attachment's real bytes in full. `fileInputStream`'s own
 * `length` (not `filesize`/`size` — confirmed against real fixtures: for a
 * genuine .doc/.xls/.jpg attachment those two properties can both disagree
 * with the actual stream's byte count, since they cover different MAPI
 * property-size semantics, while `fileInputStream.length` is what
 * `readCompletely()` actually delivers) is the one property that matches
 * the real content length byte-for-byte.
 */
function readAttachmentBytes(attachment: PSTAttachment): Buffer | null {
  const stream = attachment.fileInputStream;
  if (!stream) return null;
  const buffer = Buffer.alloc(stream.length.toNumber());
  stream.readCompletely(buffer);
  return buffer;
}

function collectAttachments(message: PSTMessage): { filenames: string[]; attachments: PstAttachment[] } {
  const filenames: string[] = [];
  const attachments: PstAttachment[] = [];

  for (let i = 0; i < message.numberOfAttachments; i++) {
    try {
      const attachment = message.getAttachment(i);
      // EMBEDDED (a forwarded original message) is handled by
      // messagesFromItem's own recursion, not here — it has no standalone
      // byte content of its own to expand into a child document.
      // BY_REFERENCE/BY_REFERENCE_RESOLVE/BY_REFERENCE_ONLY/OLE/NONE have
      // no retrievable byte stream through this same call.
      if (attachment.attachMethod !== PSTAttachment.ATTACHMENT_METHOD_BY_VALUE) continue;
      const content = readAttachmentBytes(attachment);
      if (!content || content.byteLength === 0) continue;
      const filename = stripNulBytes(attachment.longFilename || attachment.filename || "unnamed") || "unnamed";
      filenames.push(filename);
      attachments.push({ filename, content });
    } catch {
      // One unreadable attachment must never lose the rest of the
      // message's metadata or its other attachments — same contract as
      // msg.ts's own attachment loop.
    }
  }

  return { filenames, attachments };
}

function toRecord(message: PSTMessage, folderPath: string, messageClass: string): PstMessageRecord {
  const { filenames, attachments } = collectAttachments(message);
  return {
    // folderPath/messageClass are built by this module itself from real
    // folder displayNames/PR_MESSAGE_CLASS — stripped too, for the same
    // "safe in a raw column" reason as every field below, even though
    // today's callers only ever put these inside a JSON.stringify'd blob.
    folderPath: stripNulBytes(folderPath),
    messageClass: stripNulBytes(messageClass),
    from: messageFrom(message),
    to: message.displayTo ? stripNulBytes(message.displayTo) || null : null,
    cc: message.displayCC ? stripNulBytes(message.displayCC) || null : null,
    subject: message.subject ? stripNulBytes(message.subject) || null : null,
    date: messageDate(message),
    bodyText: message.body ? stripNulBytes(message.body) || null : null,
    // pst-extractor returns '' (not undefined/null) for "this message has
    // no HTML body" — normalized to null here so downstream code (and the
    // viewer) can use the same "absent" check it already uses for every
    // other extractor's optional fields, rather than treating an empty
    // string as real, renderable HTML.
    bodyHtml: message.bodyHTML ? stripNulBytes(message.bodyHTML) || null : null,
    sizeBytes: message.messageSize.toNumber(),
    attachmentFilenames: filenames,
    attachments,
  };
}

async function* messagesFromItem(item: PSTMessage, folderPath: string, depth: number): AsyncGenerator<PstMessageRecord> {
  const messageClass = item.messageClass ?? "";
  // Contacts/tasks/calendar/distribution-lists/etc. are a deliberate scope
  // cut (same "explicitly unsupported, not silently unconsidered"
  // precedent contentType.ts's own comment already documents) — IPM.Note*
  // covers plain notes and the variants (S/MIME-signed, "Agenda")
  // pst-extractor's own message-class switch already treats identically to
  // a plain email.
  if (!messageClass.startsWith("IPM.Note")) return;
  // Associated (FAI) items store folder settings/rules/views/forms, not
  // reviewable correspondence.
  if (item.isAssociated) return;

  yield toRecord(item, folderPath, messageClass);

  if (depth >= MAX_EMBEDDED_DEPTH) return;

  for (let i = 0; i < item.numberOfAttachments; i++) {
    try {
      const attachment = item.getAttachment(i);
      if (attachment.attachMethod !== PSTAttachment.ATTACHMENT_METHOD_EMBEDDED) continue;
      const embedded = attachment.embeddedPSTMessage;
      if (embedded) yield* messagesFromItem(embedded, folderPath, depth + 1);
    } catch {
      // One unreadable embedded attachment must never abort the rest of
      // this message's siblings or its own already-yielded record above.
    }
  }
}

async function* walkFolder(folder: PSTFolder, folderPath: string): AsyncGenerator<PstMessageRecord> {
  // Some real folder types (search folders in particular — confirmed
  // against both real fixtures this extractor is tested against, e.g.
  // "SPAM Search Folder 2") throw when asked for their children rather
  // than returning an empty list. One folder's broken descriptor tree must
  // never abort the walk of every sibling folder still to come.
  let subfolders: PSTFolder[] = [];
  try {
    subfolders = folder.getSubFolders();
  } catch {
    subfolders = [];
  }
  for (const subfolder of subfolders) {
    const childPath = folderPath ? `${folderPath}/${subfolder.displayName}` : subfolder.displayName;
    yield* walkFolder(subfolder, childPath);
  }

  for (;;) {
    let item: PSTMessage | null;
    try {
      item = folder.getNextChild();
    } catch {
      // Corrupt folder cursor — stop walking this folder's own items, but
      // every other folder in the PST still gets walked.
      break;
    }
    if (item === null) break;
    try {
      yield* messagesFromItem(item, folderPath, 0);
    } catch {
      // One bad item must never abort its siblings or the rest of the PST.
    }
  }
}

/**
 * Walks every folder in a real Outlook .pst/.ost file — including Deleted
 * Items — yielding one message at a time. An async generator, not the
 * usual "one buffer in, one metadata object out" shape the rest of this
 * directory's extractors use: a real eDiscovery PST can hold tens of
 * thousands of items, and materializing them all up front would defeat the
 * point of streaming (see ingest.ts's pst branch, which reads this
 * generator inside its own per-message `withOrgSession()` call rather than
 * the handler's already-open outer transaction, precisely so a
 * thousands-of-messages PST never holds one matter's GUID-counter row lock
 * for its entire processing run).
 *
 * Skips anything that isn't a plain email (contacts/tasks/calendar/FAI
 * items — see messagesFromItem) and recurses into EMBEDDED attachments
 * (forwarded original messages) up to a depth of 5. One bad message or
 * folder must never abort the rest of the walk — errors are swallowed
 * per-item/per-folder, matching msg.ts's/eml.ts's own error-swallowing
 * contract.
 *
 * Throws only if the file itself can't be opened/walked at all (missing
 * path, not a real PST/OST, genuinely corrupt header) — pst-extractor's
 * own documented limitation is that it doesn't work with corrupt PST
 * files, and there is no per-file fallback for that failure the way there
 * is for a per-folder or per-item one.
 */
export async function* iteratePstMessages(pstFilePath: string): AsyncGenerator<PstMessageRecord> {
  const pstFile = new PSTFile(pstFilePath);
  try {
    yield* walkFolder(pstFile.getRootFolder(), "");
  } finally {
    pstFile.close();
  }
}
