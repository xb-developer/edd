import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { PoolClient } from "pg";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { Readable } from "node:stream";
import {
  withOrgSession,
  s3Client,
  sqsClient,
  nextMatterGuid,
  detectContentType,
  extractEmlMetadata,
  extractOfficeMetadata,
  extractMsgMetadata,
  extractDocxContent,
  extractXlsxContent,
  extractDocContent,
  extractOfficeText,
  iteratePstMessages,
  extractZipMembers,
  type OfficeTextFileType,
  DOCUMENTS_BUCKET,
} from "@xbundle/edd-workbench-core";

// Read at module-load time, matching documents.ts's own "fail loudly at
// startup, not on first request" convention — needed here too now that
// expanding an email's attachments into child documents means the worker
// itself enqueues new ingest messages, not just consumes them.
const INGEST_QUEUE_URL = process.env.EDD_WORKBENCH_INGEST_QUEUE_URL;
if (!INGEST_QUEUE_URL) {
  throw new Error("EDD_WORKBENCH_INGEST_QUEUE_URL environment variable is required");
}

// The worker task's ephemeral storage is 100 GiB (see the CDK stack's
// WorkerTaskDefinition — bumped specifically for this, from Fargate's
// 20 GiB default), but that's shared with the OS layer, the container
// image, and whatever else is transiently on disk — not dedicated purely to
// one PST's temp file. 80 GiB leaves a 20 GiB headroom buffer (chosen to
// match Fargate's own previous default ceiling, a already-proven-adequate
// number for "everything else"). A PST larger than this fails cleanly with
// a recorded ingest_error via the pre-flight check below, before ever
// starting the S3 download — converting a potential mid-stream ENOSPC into
// an observable, recorded failure, not a promise that multi-hundred-GB PSTs
// (a real possibility in enterprise litigation holds) are actually solved.
const PST_MAX_SIZE_BYTES = 80 * 1024 ** 3;

// Unlike PST (streamed to a local temp file), a zip is buffered fully in
// memory via streamToBuffer — its realistic eDiscovery size doesn't need
// disk-streaming, but that means it directly competes with the worker
// task's 1024 MiB memory limit (both the raw zip buffer AND each
// decompressed member's bytes can be live at once during extraction).
// 400 MiB leaves real headroom for the app's own baseline usage; same
// "convert a potential crash into a clean recorded failure" reasoning as
// PST's own ceiling.
const ZIP_MAX_SIZE_BYTES = 400 * 1024 ** 2;

/**
 * Postgres `text` columns can never contain a NUL byte, in any encoding —
 * confirmed for real against a genuinely corrupt PST fixture, whose thrown
 * error message embeds raw bytes from the file itself (pst-extractor's own
 * "invalid file header" error includes the header bytes it found), and
 * those bytes can include 0x00. Without this, recording the failure would
 * itself throw a second, more confusing error ("invalid byte sequence for
 * encoding UTF8: 0x00") that masks the real one — the exact failure this
 * function exists to prevent, not a hypothetical.
 */
function sanitizeForPostgresText(value: string): string {
  return value.replace(new RegExp(String.fromCharCode(0), "g"), "");
}

interface IngestMessage {
  documentId: string;
  orgId: string;
}

interface DocumentRow {
  s3_key: string | null;
  content_type_detected: string;
  matter_id: string;
  size_bytes: string;
  family_document_id: string;
  depth: number;
  parent_document_id: string | null;
}

/**
 * Expands an email/msg's real attachments (filename + bytes, not just the
 * names already stored in `metadata.attachmentFilenames`) into their own
 * child document rows: each gets a real GUID via the same counter
 * `init-upload` uses, its bytes uploaded to S3 at the usual per-document
 * key shape, and a fresh ingest message enqueued so it goes through this
 * same handler — meaning an attachment that's itself a docx/xlsx/pdf/etc.
 * (or even a nested .msg with its own attachments) gets fully processed
 * with zero special-casing, just by re-entering this function recursively
 * via the queue.
 *
 * Deliberately does NOT attempt the POC's "contiguous family GUID
 * numbering" (parent immediately followed by its children, no unrelated
 * document's GUID in between): GUID allocation happens per-file at
 * init-upload time, before the worker has even downloaded the parent's
 * bytes to discover it has attachments, so under concurrent uploads there
 * is no way to reserve a contiguous block up front without a much larger
 * change to the numbering scheme. Each child still gets a correct, unique,
 * sequential GUID and a real `parent_document_id` link — reviewers can see
 * the family relationship via the Family GUID column regardless of whether
 * the numbers happen to be contiguous.
 *
 * One unreadable/empty attachment must never fail the parent's own ingest
 * or block its siblings — errors here are swallowed per-attachment.
 *
 * `familyDocumentId`/`depth` are the PARENT's own values, not recomputed —
 * every descendant in a family tree inherits the same familyDocumentId
 * unchanged from the root, no matter how deep (matches the reference
 * Electron POC's family_id/depth model exactly). Only `parent_document_id`
 * changes at each level, tracking the direct parent. See migration 018's
 * comment for the bug this fixes: a self-join one level up on
 * parent_document_id alone gives a different "family" value at every
 * depth instead of one shared value for the whole tree.
 */
async function expandAttachments(
  client: PoolClient,
  params: {
    orgId: string;
    matterId: string;
    parentDocumentId: string;
    familyDocumentId: string;
    depth: number;
    attachments: { filename: string; content: Buffer }[];
  },
): Promise<void> {
  for (const attachment of params.attachments) {
    if (attachment.content.byteLength === 0) continue;
    try {
      const extension = attachment.filename.toLowerCase().split(".").pop() ?? "";
      const contentType = detectContentType(attachment.filename);
      const childDocumentId = randomUUID();
      const guidNumber = await nextMatterGuid(client, params.matterId);
      const s3Key = `tenants/${params.orgId}/matters/${params.matterId}/documents/${childDocumentId}/original.${extension}`;

      await client.query(
        `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')`,
        [
          childDocumentId,
          params.orgId,
          params.matterId,
          params.parentDocumentId,
          params.familyDocumentId,
          params.depth + 1,
          guidNumber,
          attachment.filename,
          extension,
          attachment.content.byteLength,
          s3Key,
          contentType,
        ],
      );

      await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: attachment.content }));
      await sqsClient.send(
        new SendMessageCommand({ QueueUrl: INGEST_QUEUE_URL, MessageBody: JSON.stringify({ documentId: childDocumentId, orgId: params.orgId }) }),
      );
    } catch {
      // Swallowed deliberately — see the function comment above.
    }
  }
}

// content_type_detected values that route straight through the shared
// officeparser-backed extractor — "html" covers both .html and .htm
// (detectContentType folds .htm into "html" already).
const OFFICE_TEXT_CONTENT_TYPES = new Set(["rtf", "odt", "ods", "odp", "epub", "html"]);

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads a document's original file from S3 and runs the
 * extension-appropriate extractor, writing the results back and marking
 * the document ready. orgId travels with the message (see documents.ts's
 * upload-complete) so this can establish RLS context without a separate
 * identity lookup. Any failure downloading or extracting (missing object,
 * corrupt file) marks the document failed with the error recorded, rather
 * than throwing — one bad document must never take down the queue
 * consumer's message loop.
 *
 * The `pst`/`zip` content types are handled as special cases, entirely
 * outside this function's own `withOrgSession` call — see handlePstIngest's
 * own comment for why. The outer session below only ever does the initial
 * existence/lookup read for those two, handing off the small amount of
 * state each handler actually needs and returning immediately afterwards,
 * so that transaction commits (and its pool connection is released) well
 * before any of the real per-message/per-member work starts.
 */
export async function handleIngestMessage(body: string): Promise<void> {
  const { documentId, orgId } = JSON.parse(body) as IngestMessage;

  const containerJob = await withOrgSession(orgId, async (client) => {
    const docRow = await client.query<DocumentRow>(
      "SELECT s3_key, content_type_detected, matter_id, size_bytes, family_document_id, depth, parent_document_id FROM documents WHERE id = $1",
      [documentId],
    );
    if (docRow.rowCount === 0) {
      // Document row is gone (e.g. deleted between upload-complete and this
      // message being processed) — nothing to do, not an error.
      return null;
    }
    const {
      s3_key: s3Key,
      content_type_detected: contentType,
      matter_id: matterId,
      size_bytes: sizeBytes,
      family_document_id: familyDocumentId,
      depth,
      parent_document_id: parentDocumentId,
    } = docRow.rows[0];

    if (contentType === "pst" || contentType === "zip") {
      return { contentType, s3Key, matterId, sizeBytes, familyDocumentId, depth, parentDocumentId };
    }

    try {
      const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key! }));
      const buffer = await streamToBuffer(object.Body as Readable);

      if (contentType === "eml") {
        const eml = await extractEmlMetadata(buffer);
        await client.query(
          `UPDATE documents
           SET title = $1, author = $2, subject = $3, doc_date = $4, metadata = $5, ingest_status = 'ready'
           WHERE id = $6`,
          [
            eml.subject,
            eml.from,
            eml.subject,
            eml.date,
            JSON.stringify({
              to: eml.to,
              cc: eml.cc,
              bodyText: eml.bodyText,
              bodyHtml: eml.bodyHtml,
              attachmentFilenames: eml.attachmentFilenames,
            }),
            documentId,
          ],
        );
        await expandAttachments(client, { orgId, matterId, parentDocumentId: documentId, familyDocumentId, depth, attachments: eml.attachments });
      } else if (contentType === "docx") {
        const office = await extractOfficeMetadata(buffer);
        const docx = await extractDocxContent(buffer);
        await client.query(
          `UPDATE documents
           SET title = $1, author = $2, subject = $3, metadata = $4, ingest_status = 'ready'
           WHERE id = $5`,
          [office.title, office.author, office.subject, JSON.stringify({ html: docx.html }), documentId],
        );
      } else if (contentType === "xlsx" || contentType === "csv") {
        // Covers .xlsx/.xls/.xla/.xlsm/.xltx (folded into "xlsx" by
        // detectContentType) and .csv — @e965/xlsx's XLSX.read transparently
        // handles OOXML, legacy BIFF, and plain CSV via the same call, so
        // one extractor covers all of them. Previously this branch also
        // called extractOfficeMetadata (JSZip-based) for title/author/
        // subject — a genuine legacy .xls/.csv buffer isn't a zip at all,
        // so that call silently returned nulls for every real .xls/.csv
        // upload despite @e965/xlsx's own workbook.Props having the same
        // fields. Dropped now that extractXlsxContent reads Props itself.
        const xlsx = await extractXlsxContent(buffer);
        await client.query(
          `UPDATE documents
           SET title = $1, author = $2, subject = $3, metadata = $4, ingest_status = 'ready'
           WHERE id = $5`,
          [xlsx.title, xlsx.author, xlsx.subject, JSON.stringify({ sheets: xlsx.sheets }), documentId],
        );
      } else if (contentType === "doc") {
        // The upload-time ".doc" extension is only a guess — real
        // litigation exports routinely mislabel RTF or a renamed .docx as
        // .doc. extractDocContent sniffs the real bytes and reports which
        // format it actually found; content_type_detected is corrected
        // here to match, the same "value changes as processing completes"
        // pattern ingest_status itself already uses (pending -> ready).
        const doc = await extractDocContent(buffer);
        const metadata = doc.html ? { html: doc.html } : doc.text ? { text: doc.text } : null;
        await client.query(
          `UPDATE documents
           SET content_type_detected = $1, metadata = $2, ingest_status = 'ready'
           WHERE id = $3`,
          [doc.detectedFormat, metadata ? JSON.stringify(metadata) : null, documentId],
        );
      } else if (OFFICE_TEXT_CONTENT_TYPES.has(contentType)) {
        // odt/ods/odp/epub/html(/htm) and genuine .rtf all go through the
        // same officeparser-backed extractor, differing only in which
        // fileType hint to pass — officeparser can't reliably auto-detect
        // magic-byte-less formats (confirmed for html) from a bare Buffer,
        // so the hint is always passed explicitly rather than sniffed. ods
        // stays text-only (no structured grid) for now, matching a gap the
        // reference implementation this format list is modeled on also has.
        const office = await extractOfficeText(buffer, contentType as OfficeTextFileType);
        await client.query(
          `UPDATE documents
           SET title = $1, author = $2, subject = $3, metadata = $4, ingest_status = 'ready'
           WHERE id = $5`,
          [office.title, office.author, office.subject, office.text ? JSON.stringify({ text: office.text }) : null, documentId],
        );
      } else if (contentType === "pptx") {
        // pptx content isn't extracted here — @aiden0z/pptx-renderer (the
        // chosen rendering library) is browser-runtime-only, so the client
        // fetches the raw file via a view-url and renders it directly
        // instead of reading pre-extracted content from metadata.
        const office = await extractOfficeMetadata(buffer);
        await client.query("UPDATE documents SET title = $1, author = $2, subject = $3, ingest_status = 'ready' WHERE id = $4", [
          office.title,
          office.author,
          office.subject,
          documentId,
        ]);
      } else if (contentType === "msg") {
        const msg = await extractMsgMetadata(buffer);
        await client.query(
          `UPDATE documents
           SET title = $1, author = $2, subject = $3, doc_date = $4, metadata = $5, ingest_status = 'ready'
           WHERE id = $6`,
          [
            msg.subject,
            msg.from,
            msg.subject,
            msg.date,
            JSON.stringify({ to: msg.to, cc: msg.cc, bodyText: msg.bodyText, attachmentFilenames: msg.attachmentFilenames }),
            documentId,
          ],
        );
        await expandAttachments(client, { orgId, matterId, parentDocumentId: documentId, familyDocumentId, depth, attachments: msg.attachments });
      } else {
        // pdf/image/text/tiff/other: no extractor built for these yet —
        // pdf text/OCR and image/tiff OCR are a separate, later phase (need
        // a dedicated OCR queue/service so a slow scanned-PDF job can't
        // block fast eml/docx ingestion sitting behind it). filename/ext/
        // size/mtime were already captured at upload-init time, which is
        // all these types get for now.
        await client.query("UPDATE documents SET ingest_status = 'ready' WHERE id = $1", [documentId]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await client.query("UPDATE documents SET ingest_status = 'failed', ingest_error = $1 WHERE id = $2", [message, documentId]);
    }
    return null;
  });

  if (containerJob?.contentType === "pst") {
    await handlePstIngest({
      documentId,
      orgId,
      matterId: containerJob.matterId,
      s3Key: containerJob.s3Key,
      sizeBytes: containerJob.sizeBytes,
      parentDocumentId: containerJob.parentDocumentId,
      familyDocumentId: containerJob.familyDocumentId,
      depth: containerJob.depth,
    });
  } else if (containerJob?.contentType === "zip") {
    await handleZipIngest({
      documentId,
      orgId,
      matterId: containerJob.matterId,
      s3Key: containerJob.s3Key,
      sizeBytes: containerJob.sizeBytes,
      parentDocumentId: containerJob.parentDocumentId,
      familyDocumentId: containerJob.familyDocumentId,
      depth: containerJob.depth,
    });
  }
}

/**
 * A PST/OST/zip is a "transparent container" — like the reference Electron
 * POC's own treatment of mbox: no document row for the container itself,
 * each message/member becomes its own real node in the family tree exactly
 * as if the container were never there. Concretely, this means each
 * message/member inherits the CONTAINER's own parent/family/depth
 * unchanged, rather than treating the container as their real parent:
 *
 *   containerIsTopLevel = (container.parentDocumentId === null)
 *   message.parent_document_id = container.parentDocumentId   // pass through (null if top-level)
 *   message.family_document_id = containerIsTopLevel ? <message's own new id> : container.familyDocumentId
 *   message.depth              = container.depth               // SAME depth — container is elided, not a level
 *
 * If the container was a plain top-level upload, its own parentDocumentId
 * is null, so each message becomes its own independent family root — "no
 * document row for the container, each message its own family" exactly as
 * asked. If the container instead arrived nested (e.g. a .zip attached to
 * an email — expandAttachments already recurses on any content type, so
 * this is a real, common case, not hypothetical), its messages/members
 * become direct children of that real ancestor, skipping over the
 * invisible container level rather than losing the real evidentiary link
 * to it. A message's OWN attachments are unaffected by any of this — a
 * message is a real node (not transparent), so its attachments get
 * `parent_document_id = <the message's own id>` and inherit the message's
 * own family_document_id/depth+1, exactly like today.
 *
 * The container's own row (and S3 object) is deleted only once EVERY
 * message/member inside it was extracted successfully — if any failed,
 * the container's row is kept exactly as before (visible, ingest_status
 * 'ready', metadata recording the count/failedCount) so the failure stays
 * traceable. Deliberate simplification, not silently decided: in that kept
 * case the messages that DID succeed still use the pass-through parent/
 * family computed once before the loop starts, not a real link back to
 * the still-visible container — retroactively re-parenting already-
 * committed rows for a rare partial-failure case isn't worth the
 * complexity.
 */
interface ContainerIngestParams {
  documentId: string;
  orgId: string;
  matterId: string;
  s3Key: string | null;
  sizeBytes: string;
  parentDocumentId: string | null;
  familyDocumentId: string;
  depth: number;
}

/** The parent_document_id/family_document_id every message/member inside a transparent container should use — computed once from the container's own already-persisted row, per this function's own top-of-file comment. */
function containerPassThrough(container: Pick<ContainerIngestParams, "parentDocumentId" | "familyDocumentId">, newOwnId: string) {
  const containerIsTopLevel = container.parentDocumentId === null;
  return {
    parentDocumentId: container.parentDocumentId,
    familyDocumentId: containerIsTopLevel ? newOwnId : container.familyDocumentId,
  };
}

/**
 * Handles a `pst`-typed document entirely outside handleIngestMessage's own
 * `withOrgSession` call. A real eDiscovery PST can hold thousands of
 * messages; inserting all of them inside the one transaction the handler
 * would otherwise already have open would hold the matter's GUID-counter
 * row lock (see nextMatterGuid) for the PST's entire processing time, and
 * one bad message partway through would roll back every sibling that had
 * already committed alongside it in that same transaction. Each message
 * below gets its own `withOrgSession` call instead — a real commit per
 * message, so a failure on message #4,000 never touches the first 3,999.
 *
 * The S3 object is streamed straight to a local temp file, not buffered in
 * memory like every other content type in this file — a PST can be
 * multiple GB, and holding one in memory would risk the worker task OOMing
 * long before any per-message processing even starts. Cleaned up via
 * `unlink` in the `finally` below regardless of outcome.
 */
async function handlePstIngest(params: ContainerIngestParams): Promise<void> {
  const { documentId, orgId, matterId, s3Key, sizeBytes, parentDocumentId, familyDocumentId, depth } = params;

  // Pre-flight size check, before starting the S3 download — see
  // PST_MAX_SIZE_BYTES's own comment for the ceiling's reasoning. Failing
  // here with a recorded ingest_error is the whole point: better an
  // observable, expected failure than a mid-stream ENOSPC once the
  // download is already most of the way through a PST this worker task
  // was never going to have room for.
  if (Number(sizeBytes) > PST_MAX_SIZE_BYTES) {
    await withOrgSession(orgId, (client) =>
      client.query("UPDATE documents SET ingest_status = 'failed', ingest_error = $1 WHERE id = $2", [
        `PST is ${sizeBytes} bytes, exceeding this worker's ${PST_MAX_SIZE_BYTES}-byte ceiling (see ingest.ts's PST_MAX_SIZE_BYTES)`,
        documentId,
      ]),
    );
    return;
  }
  if (!s3Key) {
    // Shouldn't happen for a freshly-uploaded pst (s3_key is only ever
    // null for a PST-internal message's own child row, never the PST
    // document itself) — guarded explicitly rather than passing a null
    // Key into GetObjectCommand and getting an opaque S3 client error.
    await withOrgSession(orgId, (client) =>
      client.query("UPDATE documents SET ingest_status = 'failed', ingest_error = $1 WHERE id = $2", [
        "PST document has no s3_key to download",
        documentId,
      ]),
    );
    return;
  }

  const tempFilePath = join(tmpdir(), `pst-ingest-${documentId}.pst`);
  let messageCount = 0;
  let failedMessageCount = 0;

  try {
    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key }));
    await pipeline(object.Body as Readable, createWriteStream(tempFilePath));

    for await (const message of iteratePstMessages(tempFilePath)) {
      try {
        // One transaction per message (see this function's own top
        // comment) — everything about turning one PST message into a
        // child document (its own row plus its own attachments' child
        // rows) commits or rolls back as a unit, independently of every
        // other message.
        await withOrgSession(orgId, async (client) => {
          const childDocumentId = randomUUID();
          const guidNumber = await nextMatterGuid(client, matterId);
          const filename = `${(message.subject || "(no subject)").replace(/[\\/:*?"<>|]/g, "_").slice(0, 200)}.eml`;
          // Transparent-container pass-through — see this file's own
          // top-of-section comment. The PST itself is elided: a message
          // lands at the SAME depth/parent/family the PST itself occupied,
          // not one level "inside" it.
          const passThrough = containerPassThrough({ parentDocumentId, familyDocumentId }, childDocumentId);

          await client.query(
            `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status, title, author, subject, doc_date, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'eml', 0, NULL, 'eml', 'ready', $9, $10, $9, $11, $12)`,
            [
              childDocumentId,
              orgId,
              matterId,
              passThrough.parentDocumentId,
              passThrough.familyDocumentId,
              depth,
              guidNumber,
              filename,
              message.subject,
              message.from,
              message.date,
              JSON.stringify({
                to: message.to,
                cc: message.cc,
                bodyText: message.bodyText,
                bodyHtml: message.bodyHtml,
                attachmentFilenames: message.attachmentFilenames,
                source: "pst",
                folderPath: message.folderPath,
                messageClass: message.messageClass,
              }),
            ],
          );

          // The message itself IS a real node — its own attachments are
          // its real children, one level deeper, same as today.
          await expandAttachments(client, {
            orgId,
            matterId,
            parentDocumentId: childDocumentId,
            familyDocumentId: passThrough.familyDocumentId,
            depth,
            attachments: message.attachments,
          });
        });
        messageCount++;
      } catch {
        // One bad message must never abort the rest of the PST — matches
        // expandAttachments's own per-attachment swallow contract, applied
        // here per-message instead.
        failedMessageCount++;
      }
    }

    if (failedMessageCount === 0) {
      // Fully successful — transparent: the PST itself contributes no
      // evidentiary content beyond what's now captured as its own
      // messages, so it (and its original bytes) are removed rather than
      // left as an empty husk with nothing left to review.
      await withOrgSession(orgId, (client) => client.query("DELETE FROM documents WHERE id = $1", [documentId]));
      await s3Client.send(new DeleteObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key })).catch((err) => {
        console.error(`Failed to delete S3 object ${s3Key} for transparently-expanded PST ${documentId}:`, err);
      });
    } else {
      await withOrgSession(orgId, (client) =>
        client.query("UPDATE documents SET ingest_status = 'ready', metadata = $1 WHERE id = $2", [
          JSON.stringify({ messageCount, failedMessageCount }),
          documentId,
        ]),
      );
    }
  } catch (err) {
    // The PST itself couldn't be opened/streamed at all (missing S3
    // object, genuinely corrupt file — pst-extractor's own documented
    // limitation) — the parent document is marked failed, same as every
    // other content type's failure path.
    const message = sanitizeForPostgresText(err instanceof Error ? err.message : String(err));
    await withOrgSession(orgId, (client) =>
      client.query("UPDATE documents SET ingest_status = 'failed', ingest_error = $1 WHERE id = $2", [message, documentId]),
    );
  } finally {
    await unlink(tempFilePath).catch(() => {
      // Best-effort cleanup — a failed unlink (e.g. the write itself never
      // created the file) must never mask whatever the real outcome above
      // already was.
    });
  }
}

/**
 * Handles a `zip`-typed document — the same transparent-container treatment
 * as `handlePstIngest` (see that function's own top-of-section comment for
 * the pass-through formula), but simpler: a zip's realistic eDiscovery
 * size doesn't need PST's disk-streaming/temp-file treatment, so the
 * archive is buffered fully in memory via `streamToBuffer` (guarded by
 * `ZIP_MAX_SIZE_BYTES`, since that buffer now competes with the worker
 * task's own memory limit rather than disk). Still one transaction per
 * member, not one big transaction for the whole archive — same
 * lock-avoidance reasoning as PST, since a zip can still hold many members.
 */
async function handleZipIngest(params: ContainerIngestParams): Promise<void> {
  const { documentId, orgId, matterId, s3Key, sizeBytes, parentDocumentId, familyDocumentId, depth } = params;

  if (Number(sizeBytes) > ZIP_MAX_SIZE_BYTES) {
    await withOrgSession(orgId, (client) =>
      client.query("UPDATE documents SET ingest_status = 'failed', ingest_error = $1 WHERE id = $2", [
        `Zip is ${sizeBytes} bytes, exceeding this worker's ${ZIP_MAX_SIZE_BYTES}-byte ceiling (see ingest.ts's ZIP_MAX_SIZE_BYTES)`,
        documentId,
      ]),
    );
    return;
  }
  if (!s3Key) {
    await withOrgSession(orgId, (client) =>
      client.query("UPDATE documents SET ingest_status = 'failed', ingest_error = $1 WHERE id = $2", [
        "Zip document has no s3_key to download",
        documentId,
      ]),
    );
    return;
  }

  let memberCount = 0;
  let failedMemberCount = 0;

  try {
    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key }));
    const buffer = await streamToBuffer(object.Body as Readable);
    const members = await extractZipMembers(buffer);

    for (const member of members) {
      if (member.content.byteLength === 0) continue;
      try {
        // One transaction per member — same reasoning as PST's own
        // per-message transactions.
        await withOrgSession(orgId, async (client) => {
          const extension = member.filename.toLowerCase().split(".").pop() ?? "";
          const contentType = detectContentType(member.filename);
          const childDocumentId = randomUUID();
          const guidNumber = await nextMatterGuid(client, matterId);
          const childS3Key = `tenants/${orgId}/matters/${matterId}/documents/${childDocumentId}/original.${extension}`;
          // Transparent-container pass-through — see handlePstIngest's own
          // top-of-section comment. The zip itself is elided: a member
          // lands at the SAME depth/parent/family the zip itself occupied.
          const passThrough = containerPassThrough({ parentDocumentId, familyDocumentId }, childDocumentId);

          await client.query(
            `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13)`,
            [
              childDocumentId,
              orgId,
              matterId,
              passThrough.parentDocumentId,
              passThrough.familyDocumentId,
              depth,
              guidNumber,
              member.filename,
              extension,
              member.content.byteLength,
              childS3Key,
              contentType,
              JSON.stringify({ source: "zip", zipPath: member.zipPath }),
            ],
          );

          await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: childS3Key, Body: member.content }));
          // A member gets fully processed by re-entering this same handler
          // recursively via the queue — no special-casing needed even if
          // it's itself an eml/docx/nested-zip/nested-pst, matching
          // expandAttachments's own established recursion pattern.
          await sqsClient.send(
            new SendMessageCommand({ QueueUrl: INGEST_QUEUE_URL, MessageBody: JSON.stringify({ documentId: childDocumentId, orgId }) }),
          );
        });
        memberCount++;
      } catch {
        // One bad member must never abort the rest of the zip.
        failedMemberCount++;
      }
    }

    if (failedMemberCount === 0) {
      // Fully successful — transparent, same reasoning as a fully-
      // successful PST.
      await withOrgSession(orgId, (client) => client.query("DELETE FROM documents WHERE id = $1", [documentId]));
      await s3Client.send(new DeleteObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key })).catch((err) => {
        console.error(`Failed to delete S3 object ${s3Key} for transparently-expanded zip ${documentId}:`, err);
      });
    } else {
      await withOrgSession(orgId, (client) =>
        client.query("UPDATE documents SET ingest_status = 'ready', metadata = $1 WHERE id = $2", [
          JSON.stringify({ memberCount, failedMemberCount }),
          documentId,
        ]),
      );
    }
  } catch (err) {
    // The zip itself couldn't be opened at all (missing S3 object,
    // genuinely corrupt archive) — the parent document is marked failed,
    // same as every other content type's failure path.
    const message = sanitizeForPostgresText(err instanceof Error ? err.message : String(err));
    await withOrgSession(orgId, (client) =>
      client.query("UPDATE documents SET ingest_status = 'failed', ingest_error = $1 WHERE id = $2", [message, documentId]),
    );
  }
}
