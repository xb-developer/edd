import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { simpleParser } from "mailparser";
import MsgReader from "./msgReader.js";
import { toArrayBuffer } from "./buffer.js";

export interface ExtractedChild {
  tempPath: string;
  originalName: string;
}

export interface ChildExtraction {
  children: ExtractedChild[];
  /** Removes the temp staging directory. Call once every child has been imported. */
  cleanup: () => Promise<void>;
}

export function uniqueNamer() {
  const used = new Set<string>();
  return (name: string): string => {
    let candidate = name || "item";
    let counter = 1;
    while (used.has(candidate)) {
      candidate = `${counter}-${name || "item"}`;
      counter++;
    }
    used.add(candidate);
    return candidate;
  };
}

// Zip/attachment filenames come from the source system and are already
// filesystem-safe. A subject line pulled out of an mbox/PST message is not
// — "RE: Q3 budget?" has a colon and question mark, both illegal in a
// Windows path, and would otherwise crash the staging write outright.
export function sanitizeForFilesystem(name: string, fallback: string): string {
  const cleaned = (name || "").replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 150);
}

export async function extractZipMembers(zipPath: string): Promise<ChildExtraction> {
  const dir = await mkdtemp(path.join(tmpdir(), "edd-zip-"));
  const buf = await readFile(zipPath);
  const zip = await JSZip.loadAsync(buf);
  const children: ExtractedChild[] = [];
  const namer = uniqueNamer();

  for (const entryName of Object.keys(zip.files)) {
    const entry = zip.files[entryName];
    if (entry.dir) continue;
    const content = await entry.async("nodebuffer");
    const originalName = path.basename(entryName) || entryName;
    const stagedName = namer(sanitizeForFilesystem(originalName, "item"));
    const tempPath = path.join(dir, stagedName);
    await writeFile(tempPath, content);
    children.push({ tempPath, originalName });
  }

  return { children, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Cheap header-only read (no full MIME parse) — used both for mbox's own
// envelope-delimited messages and for naming an embedded/forwarded email
// attachment that arrived with no filename (see extractEmailAttachments,
// and content.ts's previewEml which needs the identical derivation for its
// own separate attachment-chip display).
export function extractEmailSubject(messageBuf: Buffer): string | null {
  const headerEnd = messageBuf.indexOf("\n\n");
  const headerText = (headerEnd !== -1 ? messageBuf.subarray(0, headerEnd) : messageBuf).toString("utf-8");
  const match = /^Subject:\s*(.+?)\s*$/im.exec(headerText);
  return match ? match[1] : null;
}

// An embedded/forwarded email (a genuine mailparser "message/rfc822" part)
// is frequently attached with no filename at all — real mail clients
// aren't required to set Content-Disposition's filename param for this
// content type (confirmed on a real test bundle: 0 of 1 embedded messages
// had one). Shared by extractEmailAttachments (below, where a missing name
// meant it never matched RECURSIVE_EXTS and its own attachments were
// silently never extracted) and content.ts's previewEml (where a missing
// name meant its attachment chip showed the bare literal string
// "attachment") — kept as one function specifically so the two can't drift
// out of sync the way they already did once today.
export function nameEmbeddedEmailAttachment(a: { filename?: string | null; contentType: string; content: Buffer }): string | undefined {
  if (a.filename) return a.filename;
  if (a.contentType !== "message/rfc822") return undefined;
  return `${extractEmailSubject(a.content) || "Embedded Email"}.eml`;
}

export async function extractMboxMembers(mboxPath: string): Promise<ChildExtraction> {
  const dir = await mkdtemp(path.join(tmpdir(), "edd-mbox-"));
  const buf = await readFile(mboxPath);
  const children: ExtractedChild[] = [];
  const namer = uniqueNamer();

  // Messages are delimited by a line starting with "From " (the mbox
  // envelope/postmark line) — not a real header, so it's stripped before
  // staging rather than passed through to mailparser.
  const marker = Buffer.from("\nFrom ");
  const starts: number[] = [];
  if (buf.subarray(0, 5).toString("ascii") === "From ") starts.push(0);
  let searchFrom = 0;
  let idx: number;
  while ((idx = buf.indexOf(marker, searchFrom)) !== -1) {
    starts.push(idx + 1);
    searchFrom = idx + marker.length;
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    const chunk = buf.subarray(start, end);
    const nl = chunk.indexOf(0x0a);
    const messageBuf = nl !== -1 ? chunk.subarray(nl + 1) : chunk;
    if (messageBuf.length === 0) continue;

    const subject = extractEmailSubject(messageBuf) || `message-${i + 1}`;
    const displayName = `${subject}.eml`;
    const safeName = namer(sanitizeForFilesystem(`${subject}.eml`, `message-${i + 1}.eml`));
    const tempPath = path.join(dir, safeName);
    await writeFile(tempPath, messageBuf);
    children.push({ tempPath, originalName: displayName });
  }

  return { children, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function extractEmailAttachments(filePath: string, extension: string): Promise<ChildExtraction> {
  const dir = await mkdtemp(path.join(tmpdir(), "edd-att-"));
  const children: ExtractedChild[] = [];
  const namer = uniqueNamer();

  async function stage(originalName: string, content: Buffer) {
    const stagedName = namer(sanitizeForFilesystem(originalName, "attachment"));
    const tempPath = path.join(dir, stagedName);
    await writeFile(tempPath, content);
    children.push({ tempPath, originalName });
  }

  if (extension === "eml") {
    const buf = await readFile(filePath);
    const parsed = await simpleParser(buf);
    for (const a of parsed.attachments ?? []) {
      // Inline body images (a signature logo, a `<img src="cid:...">` in
      // the HTML body) are not evidentiary attachments — mailparser sets
      // `related: true` specifically when a part's Content-ID is actually
      // referenced by cid: in the HTML source, which is the reliable
      // signal for "this renders inline in the body" (more reliable than
      // `contentDisposition === "inline"` alone, which some senders set
      // without the part being cid-referenced anywhere). Skipped here so
      // they're never staged as separate child documents — the parent
      // email's own stored file is an untouched byte-for-byte copy of the
      // original (see commitNode in documents.ts), so the image and its
      // cid: reference both stay intact and the image still renders
      // inline wherever the parent email itself is previewed.
      if (a.related) continue;
      await stage(nameEmbeddedEmailAttachment(a) ?? "attachment", a.content);
    }
  } else if (extension === "msg") {
    const buf = await readFile(filePath);
    const reader = new MsgReader(toArrayBuffer(buf));
    const data = reader.getFileData();
    for (const attInfo of data.attachments ?? []) {
      // Same inline-body-image case as the .eml branch above, just a
      // different signal: Outlook sets the standard MAPI property
      // PidTagAttachmentHidden (surfaced here as `attachmentHidden`) on an
      // attachment that's referenced by cid: in the HTML body rather than
      // meant to be shown as a real attachment — confirmed on a real
      // test .msg (all 4 inline signature images had it set, the genuine
      // PDF/embedded-email attachments didn't). Skipped for the same
      // reason: the parent .msg's own stored file is an untouched copy,
      // so the image still renders wherever the parent itself is
      // previewed, it's just never staged as a separate child document.
      if (attInfo.attachmentHidden) continue;
      const att = reader.getAttachment(attInfo);
      await stage(att.fileName || attInfo.fileName || "attachment", Buffer.from(att.content));
    }
  }

  return { children, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
