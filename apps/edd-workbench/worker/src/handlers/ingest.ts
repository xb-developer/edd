import { GetObjectCommand } from "@aws-sdk/client-s3";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { Readable } from "node:stream";
import {
  withOrgSession,
  s3Client,
  sqsClient,
  extractEmlMetadata,
  extractOfficeMetadata,
  extractMsgMetadata,
  extractDocxContent,
  extractXlsxContent,
  extractDocContent,
  extractOfficeText,
  type OfficeTextFileType,
  extractPdfTextLayer,
  DOCUMENTS_BUCKET,
} from "@xbundle/edd-workbench-core";
import { expandRealNodeAttachments, handlePstIngest, handleZipIngest, handleSevenZipIngest, handleMboxIngest } from "./containerExpansion.js";

// Read at module-load time, matching this file's other env-var
// conventions (see containerExpansion.ts's own INGEST_QUEUE_URL).
const OCR_QUEUE_URL = process.env.EDD_WORKBENCH_OCR_QUEUE_URL;
if (!OCR_QUEUE_URL) {
  throw new Error("EDD_WORKBENCH_OCR_QUEUE_URL environment variable is required");
}
const EMBEDDING_QUEUE_URL = process.env.EDD_WORKBENCH_EMBEDDING_QUEUE_URL;
if (!EMBEDDING_QUEUE_URL) {
  throw new Error("EDD_WORKBENCH_EMBEDDING_QUEUE_URL environment variable is required");
}
const SEARCH_INDEX_QUEUE_URL = process.env.EDD_WORKBENCH_SEARCHINDEX_QUEUE_URL;
if (!SEARCH_INDEX_QUEUE_URL) {
  throw new Error("EDD_WORKBENCH_SEARCHINDEX_QUEUE_URL environment variable is required");
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
 * The `pst`/`zip`/`7z`/`mbox` content types are handled as special cases,
 * entirely outside this function's own `withOrgSession` call — see
 * containerExpansion.ts's own top-of-file comments for why (a real
 * eDiscovery container can hold thousands of members; one shared
 * transaction would hold the matter's GUID-counter row lock for the
 * whole container's processing time). The outer session below only ever
 * does the initial existence/lookup read for those four, handing off the
 * small amount of state each handler actually needs and returning
 * immediately afterwards, so that transaction commits (and its pool
 * connection is released) well before any of the real per-member work
 * starts.
 */
export async function handleIngestMessage(body: string): Promise<void> {
  const { documentId, orgId } = JSON.parse(body) as IngestMessage;

  // Set once we know this is a real, non-container document — every branch
  // below reaches a terminal state (ready via any extractor, the OCR
  // hand-off, or a caught failure), and today's filename search doesn't
  // gate on ingest_status, so the replacement search-index entry must be
  // created for all three, not just the success path. Container types
  // (pst/zip/7z/mbox) get their own search-index hand-off from
  // containerExpansion.ts instead, once their own per-member processing
  // actually finishes. Read after withOrgSession resolves, not inside its
  // callback, so the message is never dequeued before this transaction
  // actually commits.
  let shouldIndexForSearch = false;

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

    if (contentType === "pst" || contentType === "zip" || contentType === "7z" || contentType === "mbox") {
      return { contentType, s3Key, matterId, sizeBytes, familyDocumentId, depth, parentDocumentId };
    }

    shouldIndexForSearch = true;

    // Every branch below reaches 'ready' except the OCR hand-off, which
    // stays 'processing' — embedding only makes sense once there's a
    // final ingest outcome to actually read text back out of (ocrQueue.ts
    // enqueues its own embedding check once OCR itself finishes).
    let reachedReady = true;

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
        await expandRealNodeAttachments({ orgId, matterId, parent: { id: documentId, familyDocumentId, depth }, attachments: eml.attachments });
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
        await expandRealNodeAttachments({ orgId, matterId, parent: { id: documentId, familyDocumentId, depth }, attachments: msg.attachments });
      } else if (contentType === "pdf" || contentType === "image" || contentType === "tiff") {
        // Real embedded text layer first (pdf only — cheap, no hand-off
        // needed, same fast path as every other extractor above). Only a
        // pdf can have one at all; image/tiff always fall straight to OCR.
        const textLayer = contentType === "pdf" ? await extractPdfTextLayer(buffer) : "";
        if (textLayer.length > 0) {
          await client.query("UPDATE documents SET metadata = $1, ingest_status = 'ready' WHERE id = $2", [
            JSON.stringify({ text: textLayer }),
            documentId,
          ]);
        } else {
          // No real text layer (a scanned pdf, or any image/tiff) — hand
          // off to the OCR service's own queue rather than OCR-ing here
          // in-process. OCR can take tens of seconds to minutes (rasterizing
          // a multi-page scan, then running it through Tesseract); this
          // shared ingest queue must never be blocked behind one slow job.
          // Stays 'processing' until the OCR service's own handler marks it
          // 'ready'/'failed'. ocr_status flips to 'processing' here too —
          // its own axis from ingest_status (see migration 029's comment),
          // tracking specifically whether THIS document ever needed OCR at
          // all, not just its overall ingest progress.
          await sqsClient.send(new SendMessageCommand({ QueueUrl: OCR_QUEUE_URL, MessageBody: JSON.stringify({ documentId, orgId }) }));
          await client.query("UPDATE documents SET ingest_status = 'processing', ocr_status = 'processing' WHERE id = $1", [documentId]);
          reachedReady = false;
        }
      } else {
        // text/other: no extractor built for these yet. filename/ext/
        // size/mtime were already captured at upload-init time, which is
        // all these types get for now.
        await client.query("UPDATE documents SET ingest_status = 'ready' WHERE id = $1", [documentId]);
      }

      if (reachedReady) {
        // Eligibility (content type, whether there's any real text at all)
        // is decided by the embedding handler itself, not here — every
        // 'ready' outcome gets exactly one enqueue call, see embedding.ts's
        // own comment for why that's simpler than special-casing skips at
        // every call site.
        await sqsClient.send(
          new SendMessageCommand({ QueueUrl: EMBEDDING_QUEUE_URL, MessageBody: JSON.stringify({ documentId, orgId }) }),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await client.query("UPDATE documents SET ingest_status = 'failed', ingest_error = $1 WHERE id = $2", [message, documentId]);
    }
    return null;
  });

  if (shouldIndexForSearch) {
    await sqsClient.send(
      new SendMessageCommand({ QueueUrl: SEARCH_INDEX_QUEUE_URL, MessageBody: JSON.stringify({ documentId, orgId }) }),
    );
  }

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
  } else if (containerJob?.contentType === "7z") {
    await handleSevenZipIngest({
      documentId,
      orgId,
      matterId: containerJob.matterId,
      s3Key: containerJob.s3Key,
      sizeBytes: containerJob.sizeBytes,
      parentDocumentId: containerJob.parentDocumentId,
      familyDocumentId: containerJob.familyDocumentId,
      depth: containerJob.depth,
    });
  } else if (containerJob?.contentType === "mbox") {
    await handleMboxIngest({
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
