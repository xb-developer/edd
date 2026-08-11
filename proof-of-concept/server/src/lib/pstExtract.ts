import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PSTFile, PSTFolder, PSTMessage, PSTAttachment } from "pst-extractor";
// Imported directly from its subpath (the documented way to use just the
// MIME builder) rather than the top-level nodemailer export, since this
// never sends anything over SMTP — only compiles message bytes.
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { uniqueNamer, sanitizeForFilesystem, type ChildExtraction, type ExtractedChild } from "./familyExtract.js";

// PST/OST have no native "eml" representation — a message and its
// attachments/recipients are separate object graphs read via pst-extractor.
// Rather than teach the rest of the pipeline a whole new container shape,
// each message is compiled into a real RFC822 .eml (via nodemailer's MIME
// builder) and staged exactly like a zip member — the existing eml
// metadata extraction and attachment-recursion path then handles it
// unchanged, including further nested zips/msgs/eml-in-eml.
const MAX_EMBEDDED_DEPTH = 12;

async function readAttachmentBuffer(att: PSTAttachment): Promise<Buffer | null> {
  const stream = att.fileInputStream;
  if (!stream) return null;
  const size = att.filesize;
  if (size <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(size);
  stream.readCompletely(buffer);
  return buffer;
}

async function buildEmlFromMessage(msg: PSTMessage, depth: number): Promise<Buffer> {
  const attachments: Array<{ filename: string; content: Buffer; contentType?: string }> = [];

  if (depth < MAX_EMBEDDED_DEPTH) {
    for (let i = 0; i < msg.numberOfAttachments; i++) {
      const att = msg.getAttachment(i);
      // Outlook lets a whole email be "attached" to another one (forwards)
      // — that shows up as an embedded PSTMessage rather than file bytes.
      // Compile it the same way, recursively, so it becomes a real nested
      // .eml attachment instead of being silently dropped.
      if (att.attachMethod === PSTAttachment.ATTACHMENT_METHOD_EMBEDDED && att.embeddedPSTMessage) {
        const embeddedBuf = await buildEmlFromMessage(att.embeddedPSTMessage, depth + 1);
        attachments.push({
          filename: sanitizeForFilesystem(`${att.embeddedPSTMessage.subject || "embedded-message"}.eml`, `embedded-${i}.eml`),
          content: embeddedBuf,
          contentType: "message/rfc822",
        });
        continue;
      }
      const buf = await readAttachmentBuffer(att);
      if (!buf) continue;
      attachments.push({
        filename: sanitizeForFilesystem(att.longFilename || att.filename, `attachment-${i}`),
        content: buf,
      });
    }
  }

  const senderName = msg.senderName || "";
  const senderEmail = msg.senderEmailAddress || "unknown@unknown";
  const from = senderName && senderName !== senderEmail ? `"${senderName.replace(/"/g, "'")}" <${senderEmail}>` : senderEmail;

  const composer = new MailComposer({
    from,
    to: msg.displayTo || undefined,
    cc: msg.displayCC || undefined,
    subject: msg.subject || "(no subject)",
    text: msg.body || "",
    date: msg.clientSubmitTime ?? msg.creationTime ?? undefined,
    attachments,
  });

  return composer.compile().build();
}

export async function extractPstMembers(pstPath: string): Promise<ChildExtraction> {
  const dir = await mkdtemp(path.join(tmpdir(), "edd-pst-"));
  const children: ExtractedChild[] = [];
  const namer = uniqueNamer();
  const pstFile = new PSTFile(pstPath);

  async function walkFolder(folder: PSTFolder): Promise<void> {
    if (folder.hasSubfolders) {
      for (const childFolder of folder.getSubFolders()) {
        await walkFolder(childFolder);
      }
    }
    if (folder.contentCount > 0) {
      // Every item type a folder can hold (mail, appointments, contacts,
      // tasks) descends from PSTMessage and exposes subject/body/
      // attachments — deliberately not filtering by message class, so
      // nothing in the PST is silently skipped.
      let item: PSTMessage | null = folder.getNextChild();
      let index = 0;
      while (item) {
        index++;
        try {
          const buf = await buildEmlFromMessage(item, 0);
          const displayName = `${item.subject || `message-${index}`}.eml`;
          const safeName = namer(sanitizeForFilesystem(displayName, `message-${index}.eml`));
          const tempPath = path.join(dir, safeName);
          await writeFile(tempPath, buf);
          children.push({ tempPath, originalName: displayName });
        } catch (err) {
          console.warn(`Failed to extract a PST/OST message: ${(err as Error).message}`);
        }
        item = folder.getNextChild();
      }
    }
  }

  try {
    await walkFolder(pstFile.getRootFolder());
  } finally {
    pstFile.close();
  }

  return { children, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
