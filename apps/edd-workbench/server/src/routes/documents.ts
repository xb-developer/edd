import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  withOrgSession,
  nextMatterGuid,
  formatGuid,
  s3Client,
  sqsClient,
  DOCUMENTS_BUCKET,
  detectContentType,
  MATTER_DOCUMENT_TREE_CTE,
  recordAuditEvent,
  deleteDocumentFromIndex,
  MATTER_STORAGE_QUOTA_BYTES,
  getMatterStorageUsedBytes,
  matterQuotaExceededMessage,
} from "@xbundle/edd-workbench-core";

// Read at module-load time, matching auth.ts/pool.ts's "fail loudly at
// startup, not on first request" convention elsewhere in this codebase.
const INGEST_QUEUE_URL = process.env.EDD_WORKBENCH_INGEST_QUEUE_URL;
if (!INGEST_QUEUE_URL) {
  throw new Error("EDD_WORKBENCH_INGEST_QUEUE_URL environment variable is required");
}

// mergeParams — this router is mounted at /api/matters/:matterId/documents
// (see index.ts); without it, :matterId from the parent mount path isn't
// visible on req.params inside this router.
export const documentsRouter = Router({ mergeParams: true });

interface InitUploadFile {
  filename: string;
  size: number;
  contentType?: string;
  /** The source file's own last-modified time, epoch ms — `File.lastModified`'s exact shape, so the client can pass it straight through with no conversion. Optional since not every caller of this route necessarily has it. */
  lastModified?: number;
}

// A rejected file (over the matter's storage quota) comes back as
// `{ error }` at that file's own array index, never omitted — the client
// (runImport.ts) requires one result per requested file, in the same
// order, so it can match each later file's real upload to the right
// presigned URL.
type InitUploadResult = { documentId: string; guid: string; uploadUrl: string } | { error: string };

interface DocumentRow {
  id: string;
  guid_number: number;
  parent_document_id: string | null;
  parent_guid_number: number | null;
  family_document_id: string;
  family_guid_number: number;
  depth: number;
  original_filename: string;
  extension: string;
  size_bytes: string;
  file_modified_at: string | null;
  content_type_detected: string;
  ingest_status: string;
  ingest_error: string | null;
  ocr_status: string;
  title: string | null;
  author: string | null;
  subject: string | null;
  doc_date: string | null;
  content_modified_at: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  metadata: unknown;
  content_warning: string | null;
  created_at: string;
  upload_batch_id: string;
}

// Both queries below select from the same shared tree CTE (see
// documentTree.ts) — two self-LEFT-JOINs against its own `numbered` table,
// one to the direct parent (parent_document_id) and one to the family root
// (family_document_id, migration 018), so a child's row already carries
// both its parent's and its family root's DISPLAY guid number, no separate
// lookup needed. The displayed guid/parentGuid/familyGuid are computed from
// each document's current tree position, not the raw guid_number column
// (see documentTree.ts's own comment for why) — aliased here to the same
// column names toDocumentDTO already reads, so that function needs no
// changes. Kept as one constant so the two routes below can't drift apart
// on which columns are actually selected.
const DOCUMENT_SELECT = `
  ${MATTER_DOCUMENT_TREE_CTE}
  SELECT n.*, n.display_guid_number AS guid_number,
         p.display_guid_number AS parent_guid_number, f.display_guid_number AS family_guid_number
  FROM numbered n
  LEFT JOIN numbered p ON p.id = n.parent_document_id
  LEFT JOIN numbered f ON f.id = n.family_document_id
`;

function toDocumentDTO(row: DocumentRow) {
  return {
    documentId: row.id,
    guid: formatGuid(row.guid_number),
    // The root of this document's family tree — never null, since
    // family_document_id is NOT NULL (a childless document is its own
    // family). NOT the same as "direct parent": every descendant in a
    // multi-level tree (e.g. a PST message's own attachment) shares the
    // same familyGuid as the tree's root, not its immediate parent's.
    familyGuid: formatGuid(row.family_guid_number),
    // The direct parent's guid, one level up — null for a top-level
    // document. Distinct from familyGuid at depth 2+.
    parentGuid: row.parent_guid_number !== null ? formatGuid(row.parent_guid_number) : null,
    depth: row.depth,
    originalFilename: row.original_filename,
    extension: row.extension,
    sizeBytes: Number(row.size_bytes),
    fileModifiedAt: row.file_modified_at,
    contentTypeDetected: row.content_type_detected,
    ingestStatus: row.ingest_status,
    ingestError: row.ingest_error,
    ocrStatus: row.ocr_status,
    title: row.title,
    author: row.author,
    subject: row.subject,
    docDate: row.doc_date,
    contentModifiedAt: row.content_modified_at,
    toAddresses: row.to_addresses,
    ccAddresses: row.cc_addresses,
    metadata: row.metadata,
    contentWarning: row.content_warning,
    createdAt: row.created_at,
    uploadBatchId: row.upload_batch_id,
  };
}

// Unpaginated for now — server-side pagination/filtering is explicitly
// Milestone 3's job (build plan §5), not this one. Includes full metadata
// (not just summary fields) so the viewer can render eml/msg straight from
// this response with no second fetch — revisit if/when matters grow large
// enough that shipping every row's full jsonb blob in one list response
// becomes the actual bottleneck, not before.
documentsRouter.get("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId } = req.params;

    // Both row order AND each row's own displayed guid/parentGuid/familyGuid
    // come from the same tree walk (see documentTree.ts) — a flat
    // `ORDER BY guid_number` (and showing that raw column as-is) both
    // scramble the tree: a container's direct members get consecutive raw
    // numbers, but a *grandchild* (e.g. an attachment of a nested email) is
    // only inserted once that nested email is pulled off its own SQS
    // message and reprocessed — by which point unrelated later documents
    // may already have consumed intervening numbers.
    const rows = await withOrgSession(orgId, (client) =>
      client.query<DocumentRow>(`${DOCUMENT_SELECT} ORDER BY n.sort_path`, [matterId]),
    );

    res.json(rows.rows.map(toDocumentDTO));
  } catch (err) {
    next(err);
  }
});

// Single-document fetch, mirroring view-url's authz shape (org-scoped
// lookup, 404 on miss). Used by the pop-out viewer window: it can only
// cheaply carry primitive ids through window.open()'s URL, not a full DTO,
// and re-fetching here (rather than pushing metadata through
// BroadcastChannel's structured-clone) avoids shipping potentially-large
// docx/xlsx metadata blobs across realms for no benefit.
documentsRouter.get("/:id", async (req: Request<{ matterId: string; id: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId, id: documentId } = req.params;

    // $1 (matterId) is consumed by the shared tree CTE itself — a document's
    // displayed guid can't be known without first computing its whole
    // matter's tree order, so this still walks the full matter even though
    // only one row's worth of output is returned.
    const rows = await withOrgSession(orgId, (client) =>
      client.query<DocumentRow>(`${DOCUMENT_SELECT} WHERE n.id = $2`, [matterId, documentId]),
    );
    if (rows.rowCount === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    res.json(toDocumentDTO(rows.rows[0]));
  } catch (err) {
    next(err);
  }
});

// Shared by both the single-document and bulk-delete routes below. Deletes
// every id in `documentIds` (and, via ON DELETE CASCADE on
// parent_document_id, any attachments expanded from each — see ingest.ts).
// S3 cleanup walks the FULL descendant tree (a recursive query, not just
// direct children) — a grandchild (an attachment that was itself an email
// with its own attachments) cascade-deletes at the DB level regardless of
// depth, so S3 cleanup has to match that or leave objects orphaned. S3
// object keys carry no relationship to their document's tree position
// (each document's key is `.../documents/{its-own-uuid}/original.ext`,
// independent of parent — see containerExpansion.ts), so there's no
// key-prefix shortcut for this; the recursive walk over parent_document_id
// is the only way to enumerate every descendant's own key before the rows
// (and the parent/child links used to find them) disappear.
// S3 failures are logged, not thrown — the DB rows (the thing the rest of
// the app actually treats as "does this document exist") are the part
// that must not silently fail to delete.
async function deleteDocumentsWithS3Cleanup(orgId: string, actorUserId: string, matterId: string, documentIds: string[]): Promise<number> {
  const deletedRows = await withOrgSession(orgId, async (client) => {
    const rows = await client.query<{ id: string; s3_key: string; original_filename: string }>(
      `WITH RECURSIVE descendants AS (
         SELECT id, s3_key, original_filename, parent_document_id
         FROM documents
         WHERE matter_id = $1 AND id = ANY($2::uuid[])
         UNION ALL
         SELECT c.id, c.s3_key, c.original_filename, c.parent_document_id
         FROM documents c
         JOIN descendants d ON c.parent_document_id = d.id
         WHERE c.matter_id = $1
       )
       SELECT id, s3_key, original_filename FROM descendants`,
      [matterId, documentIds],
    );
    await client.query("DELETE FROM documents WHERE matter_id = $1 AND id = ANY($2::uuid[])", [matterId, documentIds]);
    // One row per document actually removed — including every
    // cascade-deleted descendant (e.g. an email's own attachments, and
    // their own attachments in turn), not just the ids the caller
    // explicitly requested, since those rows disappear too.
    for (const row of rows.rows) {
      await recordAuditEvent(client, {
        orgId,
        actorUserId,
        matterId,
        action: "document.delete",
        description: `Deleted file "${row.original_filename}"`,
      });
    }
    return rows.rows;
  });

  await Promise.all(
    deletedRows.map((row) =>
      s3Client.send(new DeleteObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: row.s3_key })).catch((err) => {
        console.error(`Failed to delete S3 object ${row.s3_key} during a delete of matter ${matterId}'s documents:`, err);
      }),
    ),
  );
  // Same best-effort treatment as the S3 cleanup above — this is an
  // eDiscovery tool, so "the search index still has a stale entry" is a
  // real gap (privilege clawback/inadvertent-production deletes need the
  // extracted text actually gone), not just a UI cosmetic issue.
  await Promise.all(
    deletedRows.map((row) =>
      deleteDocumentFromIndex(row.id).catch((err) => {
        console.error(`Failed to remove search index entry for document ${row.id} during a delete of matter ${matterId}'s documents:`, err);
      }),
    ),
  );

  return deletedRows.length;
}

documentsRouter.delete("/:id", async (req: Request<{ matterId: string; id: string }>, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { matterId, id: documentId } = req.params;

    const exists = await withOrgSession(orgId, (client) =>
      client.query("SELECT 1 FROM documents WHERE matter_id = $1 AND id = $2", [matterId, documentId]),
    );
    if (exists.rowCount === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    await deleteDocumentsWithS3Cleanup(orgId, userId, matterId, [documentId]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Bulk delete for the table's checkbox-selection toolbar. Same
// "reject the whole request rather than silently delete a partial set"
// safety this codebase's own exportsRouter already established for its own
// bulk documentIds body — a smuggled cross-matter id, a typo, or a race
// with another delete must never result in deleting some-but-not-all of
// what the caller asked for with no indication anything was skipped.
documentsRouter.delete("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { matterId } = req.params;
    const { documentIds } = req.body as { documentIds?: string[] };

    if (!documentIds || documentIds.length === 0) {
      res.status(400).json({ error: "documentIds is required and must be non-empty" });
      return;
    }

    const owned = await withOrgSession(orgId, (client) =>
      client.query<{ id: string }>("SELECT id FROM documents WHERE matter_id = $1 AND id = ANY($2::uuid[])", [matterId, documentIds]),
    );
    if (owned.rowCount !== documentIds.length) {
      res.status(400).json({ error: "One or more documentIds do not belong to this matter" });
      return;
    }

    const deletedCount = await deleteDocumentsWithS3Cleanup(orgId, userId, matterId, documentIds);
    res.status(200).json({ deletedCount });
  } catch (err) {
    next(err);
  }
});

// Bulk retry for the Processing Status filter's checkbox selection — same
// "reject the whole request rather than silently act on a partial set"
// safety as bulk delete above. Deliberately requires every selected
// document to already be 'failed' (not just "belongs to this matter"): a
// client that only ever sends genuinely-failed selected ids never hits
// this, but a stale/manual request touching an already-ready document
// would otherwise silently re-run extraction for no reason.
documentsRouter.post("/retry-ingest", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { matterId } = req.params;
    const { documentIds } = req.body as { documentIds?: string[] };

    if (!documentIds || documentIds.length === 0) {
      res.status(400).json({ error: "documentIds is required and must be non-empty" });
      return;
    }

    const rows = await withOrgSession(orgId, (client) =>
      client.query<{ id: string; ingest_status: string }>(
        "SELECT id, ingest_status FROM documents WHERE matter_id = $1 AND id = ANY($2::uuid[])",
        [matterId, documentIds],
      ),
    );
    if (rows.rowCount !== documentIds.length) {
      res.status(400).json({ error: "One or more documentIds do not belong to this matter" });
      return;
    }
    if (rows.rows.some((r) => r.ingest_status !== "failed")) {
      res.status(400).json({ error: "One or more documentIds are not currently in a failed state" });
      return;
    }

    await withOrgSession(orgId, async (client) => {
      await client.query(
        "UPDATE documents SET ingest_status = 'pending', ingest_error = NULL WHERE matter_id = $1 AND id = ANY($2::uuid[])",
        [matterId, documentIds],
      );
      for (const documentId of documentIds) {
        await recordAuditEvent(client, {
          orgId,
          actorUserId: userId,
          matterId,
          documentId,
          action: "document.retry_ingest",
          description: "Retried failed ingest",
        });
      }
    });

    // Enqueued after the transaction commits, same ordering as
    // upload-complete above — the worker must never pick up a message
    // whose 'pending' reset hasn't actually committed yet.
    await Promise.all(
      documentIds.map((documentId) =>
        sqsClient.send(new SendMessageCommand({ QueueUrl: INGEST_QUEUE_URL, MessageBody: JSON.stringify({ documentId, orgId }) })),
      ),
    );

    res.status(202).json({ retriedCount: documentIds.length });
  } catch (err) {
    next(err);
  }
});

// GUID assignment happens here, in the API request, not in the worker that
// later processes the upload — see build plan §3: numbering must stay
// deterministic and independent of extraction order/retries, so a slow,
// failed, or retried extraction never skips or double-assigns a number.
documentsRouter.post("/init-upload", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { matterId } = req.params;
    const { files, uploadBatchId } = req.body as { files?: InitUploadFile[]; uploadBatchId?: string };

    if (!files || files.length === 0) {
      res.status(400).json({ error: "files array is required" });
      return;
    }
    if (!uploadBatchId) {
      res.status(400).json({ error: "uploadBatchId is required" });
      return;
    }

    const results = await withOrgSession(orgId, async (client) => {
      // One query for the batch, then an in-memory running total — not a
      // fresh SUM per file — so files earlier in the same request count
      // against files later in it (uploading two 2GB files in one batch
      // against an empty matter must reject the second, not let both
      // through because neither alone exceeds the quota on its own).
      let usedBytes = await getMatterStorageUsedBytes(client, matterId);
      const created: InitUploadResult[] = [];
      for (const file of files) {
        if (usedBytes + file.size > MATTER_STORAGE_QUOTA_BYTES) {
          created.push({ error: matterQuotaExceededMessage(file.filename) });
          continue;
        }
        usedBytes += file.size;

        const guidNumber = await nextMatterGuid(client, matterId);
        const documentId = randomUUID();
        const extension = file.filename.toLowerCase().split(".").pop() ?? "";
        const contentTypeDetected = detectContentType(file.filename);
        const s3Key = `tenants/${orgId}/matters/${matterId}/documents/${documentId}/original.${extension}`;

        await client.query(
          `INSERT INTO documents (id, org_id, matter_id, guid_number, original_filename, extension, size_bytes, file_modified_at, s3_key, content_type_detected, ingest_status, uploaded_by, family_document_id, depth, upload_batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $1, 0, $12)`,
          [
            documentId,
            orgId,
            matterId,
            guidNumber,
            file.filename,
            extension,
            file.size,
            file.lastModified ? new Date(file.lastModified) : null,
            s3Key,
            contentTypeDetected,
            userId,
            uploadBatchId,
          ],
        );

        const uploadUrl = await getSignedUrl(
          s3Client,
          new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, ContentType: file.contentType }),
          { expiresIn: 900 },
        );

        created.push({ documentId, guid: formatGuid(guidNumber), uploadUrl });
      }
      return created;
    });

    res.status(201).json(results);
  } catch (err) {
    next(err);
  }
});

// Enqueues extraction rather than doing it inline — metadata extraction
// (unzipping Office docs, parsing OLE/CFB .msg files) is too slow/heavy for
// a synchronous HTTP request. This endpoint's only job is "confirm this
// document exists and hand it to the worker."
documentsRouter.post("/:id/upload-complete", async (req: Request<{ matterId: string; id: string }>, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { matterId, id: documentId } = req.params;

    const existing = await withOrgSession(orgId, async (client) => {
      const rows = await client.query<{ original_filename: string }>(
        "SELECT original_filename FROM documents WHERE id = $1 AND matter_id = $2",
        [documentId, matterId],
      );
      if (rows.rowCount !== 0) {
        await recordAuditEvent(client, {
          orgId,
          actorUserId: userId,
          matterId,
          documentId,
          action: "document.upload",
          description: `Uploaded file "${rows.rows[0].original_filename}"`,
        });
      }
      return rows;
    });
    if (existing.rowCount === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // orgId travels with the message — the worker needs it to establish RLS
    // context for its own document lookup, and it's already known here for
    // free (unlike the worker, which only ever receives a bare documentId
    // otherwise and would face the same identity-lookup chicken-and-egg
    // problem auth.ts's resolveOrgContext had before Auth0 Organizations
    // was dropped).
    await sqsClient.send(
      new SendMessageCommand({ QueueUrl: INGEST_QUEUE_URL, MessageBody: JSON.stringify({ documentId, orgId }) }),
    );

    res.status(202).json({ status: "queued" });
  } catch (err) {
    next(err);
  }
});

// Authz checkpoint the browser can't skip — the client never touches S3
// directly otherwise, and this verifies matter/org access before minting
// anything (build plan §4). Short-lived and minted per request, never
// cached, matching the same pattern init-upload's presigned PUT URLs use.
documentsRouter.get("/:id/view-url", async (req: Request<{ matterId: string; id: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId, id: documentId } = req.params;

    const existing = await withOrgSession(orgId, (client) =>
      client.query<{ s3_key: string | null }>("SELECT s3_key FROM documents WHERE id = $1 AND matter_id = $2", [documentId, matterId]),
    );
    if (existing.rowCount === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    if (existing.rows[0].s3_key === null) {
      // A PST-internal message document (see migration 017) has no
      // backing S3 object at all — GetObjectCommand below has no key to
      // sign and would otherwise surface as an unhandled S3 client error
      // (a 500) instead of this explicit, expected state.
      res.status(409).json({ error: "Document has no viewable original file" });
      return;
    }

    const viewUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: existing.rows[0].s3_key }),
      { expiresIn: 900 },
    );

    res.json({ viewUrl });
  } catch (err) {
    next(err);
  }
});
