import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { withOrgSession, nextMatterGuid, formatGuid, s3Client, sqsClient, DOCUMENTS_BUCKET, detectContentType } from "@xbundle/edd-workbench-core";

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

interface InitUploadResult {
  documentId: string;
  guid: string;
  uploadUrl: string;
}

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
  title: string | null;
  author: string | null;
  subject: string | null;
  doc_date: string | null;
  metadata: unknown;
  created_at: string;
}

// Both queries below select from this same shape — two self-LEFT-JOINs, one
// to the direct parent (parent_document_id) and one to the family root
// (family_document_id, migration 018) — so a child's row already carries
// both its parent's and its family root's guid_number, no separate lookup
// needed. Kept as one constant so the two routes can't drift apart on
// which columns are actually selected.
const DOCUMENT_SELECT = `
  SELECT d.*, p.guid_number AS parent_guid_number, f.guid_number AS family_guid_number
  FROM documents d
  LEFT JOIN documents p ON p.id = d.parent_document_id
  LEFT JOIN documents f ON f.id = d.family_document_id
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
    title: row.title,
    author: row.author,
    subject: row.subject,
    docDate: row.doc_date,
    metadata: row.metadata,
    createdAt: row.created_at,
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

    const rows = await withOrgSession(orgId, (client) =>
      client.query<DocumentRow>(`${DOCUMENT_SELECT} WHERE d.matter_id = $1 ORDER BY d.guid_number`, [matterId]),
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

    const rows = await withOrgSession(orgId, (client) =>
      client.query<DocumentRow>(`${DOCUMENT_SELECT} WHERE d.id = $1 AND d.matter_id = $2`, [documentId, matterId]),
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

// Deletes a document (and, via ON DELETE CASCADE on parent_document_id,
// any attachments expanded from it — see ingest.ts). Best-effort S3
// cleanup for the document itself and its direct children only — a
// grandchild (an attachment that was itself an email with its own
// attachments) would still cascade-delete at the DB level but leave its S3
// object orphaned; a storage-cleanup gap, not a correctness one, and not
// worth a recursive query for a first pass at this feature. S3 failures
// are logged, not thrown — the DB row (the thing the rest of the app
// actually treats as "does this document exist") is the part that must
// not silently fail to delete.
documentsRouter.delete("/:id", async (req: Request<{ matterId: string; id: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId, id: documentId } = req.params;

    const s3Keys = await withOrgSession(orgId, async (client) => {
      const rows = await client.query<{ s3_key: string }>(
        "SELECT s3_key FROM documents WHERE matter_id = $1 AND (id = $2 OR parent_document_id = $2)",
        [matterId, documentId],
      );
      if (rows.rowCount === 0) return null;
      await client.query("DELETE FROM documents WHERE id = $1 AND matter_id = $2", [documentId, matterId]);
      return rows.rows.map((r) => r.s3_key);
    });

    if (s3Keys === null) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    await Promise.all(
      s3Keys.map((key) =>
        s3Client.send(new DeleteObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: key })).catch((err) => {
          console.error(`Failed to delete S3 object ${key} for deleted document ${documentId}:`, err);
        }),
      ),
    );

    res.status(204).send();
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
    const { files } = req.body as { files?: InitUploadFile[] };

    if (!files || files.length === 0) {
      res.status(400).json({ error: "files array is required" });
      return;
    }

    const results = await withOrgSession(orgId, async (client) => {
      const created: InitUploadResult[] = [];
      for (const file of files) {
        const guidNumber = await nextMatterGuid(client, matterId);
        const documentId = randomUUID();
        const extension = file.filename.toLowerCase().split(".").pop() ?? "";
        const contentTypeDetected = detectContentType(file.filename);
        const s3Key = `tenants/${orgId}/matters/${matterId}/documents/${documentId}/original.${extension}`;

        await client.query(
          `INSERT INTO documents (id, org_id, matter_id, guid_number, original_filename, extension, size_bytes, file_modified_at, s3_key, content_type_detected, ingest_status, uploaded_by, family_document_id, depth)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $1, 0)`,
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
    const { orgId } = req.eddContext!;
    const { matterId, id: documentId } = req.params;

    const existing = await withOrgSession(orgId, (client) =>
      client.query("SELECT id FROM documents WHERE id = $1 AND matter_id = $2", [documentId, matterId]),
    );
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
