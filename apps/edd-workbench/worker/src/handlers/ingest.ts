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
  extractPdfMetadata,
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

    // Real bug this fixed: withOrgSession wraps this whole callback in ONE
    // transaction (see session.ts) — a query failure anywhere in the try
    // block below leaves that transaction aborted (Postgres error 25P02,
    // "current transaction is aborted"), so the catch handler's OWN
    // "mark ingest_status = 'failed'" UPDATE then failed too, propagating
    // out of withOrgSession, rolling back the whole transaction (including
    // the harmless docRow SELECT above), and leaving the document stuck at
    // 'pending' forever with no ingest_error ever recorded — the real
    // original error was silently lost, and the document was invisible to
    // both the "failed" filter and RetryIngestButton (which only surfaces
    // ingestStatus === 'failed'). Confirmed for real against a batch upload
    // where several old, generic "mime001.txt"-named MIME parts turned out
    // to be raw OLE2 binary (Compound File Binary magic bytes), not text —
    // buffer.toString("utf-8") on binary content routinely produces NUL
    // bytes, which jsonb (and Postgres text generally) rejects outright.
    // ROLLBACK TO SAVEPOINT restores the transaction to a usable state
    // before the catch handler tries to record the failure, so this
    // degrades to a normal, visible, retriable 'failed' document instead
    // of a silent black hole — for this cause and any other extraction
    // failure, not just this one.
    await client.query("SAVEPOINT extraction_attempt");

    try {
      const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key! }));
      const buffer = await streamToBuffer(object.Body as Readable);

      if (contentType === "eml") {
        const eml = await extractEmlMetadata(buffer);
        await client.query(
          `UPDATE documents
           SET title = $1, author = $2, subject = $3, doc_date = $4, to_addresses = $5, cc_addresses = $6, metadata = $7, ingest_status = 'ready'
           WHERE id = $8`,
          [
            eml.subject,
            eml.from,
            eml.subject,
            eml.date,
            eml.to,
            eml.cc,
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
           SET title = $1, author = $2, subject = $3, content_modified_at = $4, metadata = $5, ingest_status = 'ready'
           WHERE id = $6`,
          [office.title, office.author, office.subject, office.modified, JSON.stringify({ html: docx.html }), documentId],
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
           SET title = $1, author = $2, subject = $3, content_modified_at = $4, metadata = $5, ingest_status = 'ready'
           WHERE id = $6`,
          [xlsx.title, xlsx.author, xlsx.subject, xlsx.modified, JSON.stringify({ sheets: xlsx.sheets }), documentId],
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
           SET content_type_detected = $1, title = $2, author = $3, subject = $4, content_modified_at = $5, metadata = $6, ingest_status = 'ready'
           WHERE id = $7`,
          [doc.detectedFormat, doc.title, doc.author, doc.subject, doc.modified, metadata ? JSON.stringify(metadata) : null, documentId],
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
           SET title = $1, author = $2, subject = $3, content_modified_at = $4, metadata = $5, ingest_status = 'ready'
           WHERE id = $6`,
          [office.title, office.author, office.subject, office.modified, office.text ? JSON.stringify({ text: office.text }) : null, documentId],
        );
      } else if (contentType === "pptx") {
        // pptx content isn't extracted here — @aiden0z/pptx-renderer (the
        // chosen rendering library) is browser-runtime-only, so the client
        // fetches the raw file via a view-url and renders it directly
        // instead of reading pre-extracted content from metadata.
        const office = await extractOfficeMetadata(buffer);
        await client.query(
          "UPDATE documents SET title = $1, author = $2, subject = $3, content_modified_at = $4, ingest_status = 'ready' WHERE id = $5",
          [office.title, office.author, office.subject, office.modified, documentId],
        );
      } else if (contentType === "msg") {
        const msg = await extractMsgMetadata(buffer);
        await client.query(
          `UPDATE documents
           SET title = $1, author = $2, subject = $3, doc_date = $4, to_addresses = $5, cc_addresses = $6, metadata = $7, ingest_status = 'ready'
           WHERE id = $8`,
          [
            msg.subject,
            msg.from,
            msg.subject,
            msg.date,
            msg.to,
            msg.cc,
            JSON.stringify({ to: msg.to, cc: msg.cc, bodyText: msg.bodyText, attachmentFilenames: msg.attachmentFilenames }),
            documentId,
          ],
        );
        await expandRealNodeAttachments({ orgId, matterId, parent: { id: documentId, familyDocumentId, depth }, attachments: msg.attachments });
      } else if (contentType === "pdf" || contentType === "image" || contentType === "tiff") {
        // Title/author/subject/modified live in the PDF's own Info
        // dictionary independently of whether it has a real text layer —
        // a scanned pdf (headed to OCR below either way) can still have
        // real /Author metadata worth keeping, so this runs unconditionally
        // before the text-layer/OCR branching decides ingest_status.
        // image/tiff aren't real PDFs at all, so there's nothing to read.
        if (contentType === "pdf") {
          const pdfMetadata = await extractPdfMetadata(buffer);
          await client.query("UPDATE documents SET title = $1, author = $2, subject = $3, content_modified_at = $4 WHERE id = $5", [
            pdfMetadata.title,
            pdfMetadata.author,
            pdfMetadata.subject,
            pdfMetadata.modified,
            documentId,
          ]);
        }
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
      } else if (contentType === "text") {
        // Plain .txt — no container/markup to parse, just decode the bytes.
        // UTF-8, with no charset sniffing/BOM handling: unlike the
        // Windows-1252-heavy .msg HTML bodies (see msg.ts), a plain-text
        // litigation export is UTF-8 or plain ASCII (a UTF-8 subset) in
        // every real file this pipeline has seen. Previously this branch
        // fell into the generic "other" no-op below, so .txt uploads
        // completed as ingestStatus 'ready' with metadata null — invisible
        // to search/`/ask` with nothing telling the reviewer why (see
        // COLLATE_SECURITY_FINDINGS.md Finding 5).
        //
        // Merges into metadata (COALESCE + `||`) rather than replacing it —
        // a .txt expanded out of a zip/7z/mbox already has metadata set at
        // insert time (`{source, zipPath}`/`{source, mboxIndex}`, see
        // containerExpansion.ts) and is re-ingested through this same
        // handler; overwriting the column outright would silently erase
        // that provenance.
        //
        // Strips NUL bytes before storing — a real production repro: a
        // batch of generically-named "mime001.txt" MIME parts turned out to
        // be raw OLE2 binary (Compound File Binary magic bytes), not text
        // at all. buffer.toString("utf-8") doesn't throw on arbitrary bytes
        // (Node's UTF-8 decoding is lenient), but the NUL bytes ordinary
        // binary data contains are perfectly valid JS string characters
        // that Postgres text/jsonb flatly rejects — this crashed the
        // extraction query outright for every one of these files. A
        // mis-extension'd binary file becoming unsearchable garbage text
        // instead of a crash is the acceptable degradation here, matching
        // every other extractor's own "never throw on malformed input"
        // contract.
        const text = buffer.toString("utf-8").replace(new RegExp(String.fromCharCode(0), "g"), "").trim();
        await client.query(
          "UPDATE documents SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, ingest_status = 'ready' WHERE id = $2",
          [JSON.stringify(text ? { text } : {}), documentId],
        );
      } else {
        // "other": genuinely unrecognized extensions with no extractor
        // built for them. filename/ext/size/mtime were already captured at
        // upload-init time, which is all these get for now.
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
      await client.query("ROLLBACK TO SAVEPOINT extraction_attempt");
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
