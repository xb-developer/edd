import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { withOrgSession, s3Client, sqsClient, DOCUMENTS_BUCKET } from "@xbundle/edd-workbench-core";

// Read at module-load time, matching documents.ts/ingest.ts's own "fail
// loudly at startup, not on first request" convention.
const EXPORT_QUEUE_URL = process.env.EDD_WORKBENCH_EXPORT_QUEUE_URL;
if (!EXPORT_QUEUE_URL) {
  throw new Error("EDD_WORKBENCH_EXPORT_QUEUE_URL environment variable is required");
}

// mergeParams — this router is mounted at /api/matters/:matterId/exports
// (see index.ts); without it, :matterId from the parent mount path isn't
// visible on req.params inside this router.
export const exportsRouter = Router({ mergeParams: true });

const EXPORT_KINDS = new Set(["documents", "properties"]);

interface ExportRow {
  id: string;
  kind: string;
  status: string;
  error: string | null;
  result_s3_key: string | null;
}

// No role gate — exporting doesn't mutate matter data (matches the plan's
// "no role gate" note for this route, unlike tag-mutating endpoints).
exportsRouter.post("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { matterId } = req.params;
    const { kind, documentIds } = req.body as { kind?: string; documentIds?: string[] };

    if (!kind || !EXPORT_KINDS.has(kind)) {
      res.status(400).json({ error: "kind must be one of 'documents' or 'properties'" });
      return;
    }
    if (!documentIds || documentIds.length === 0) {
      res.status(400).json({ error: "documentIds is required and must be non-empty" });
      return;
    }

    const exportId = await withOrgSession(orgId, async (client) => {
      // Validate every id actually belongs to this matter BEFORE creating
      // the job row — a bad selection (smuggled cross-matter id, typo, a
      // race with a delete) must never enqueue anything.
      const owned = await client.query<{ id: string }>("SELECT id FROM documents WHERE matter_id = $1 AND id = ANY($2::uuid[])", [
        matterId,
        documentIds,
      ]);
      if (owned.rowCount !== documentIds.length) {
        return null;
      }

      const id = randomUUID();
      await client.query(
        `INSERT INTO matter_exports (id, org_id, matter_id, kind, document_ids, status, requested_by)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
        [id, orgId, matterId, kind, documentIds, userId],
      );
      return id;
    });

    if (exportId === null) {
      res.status(400).json({ error: "One or more documentIds do not belong to this matter" });
      return;
    }

    // orgId travels with the message — the worker needs it to establish
    // RLS context for its own lookup, matching upload-complete's own ingest
    // enqueue in documents.ts.
    await sqsClient.send(new SendMessageCommand({ QueueUrl: EXPORT_QUEUE_URL, MessageBody: JSON.stringify({ exportId, orgId }) }));

    res.status(201).json({ exportId, status: "pending" });
  } catch (err) {
    next(err);
  }
});

exportsRouter.get("/:exportId", async (req: Request<{ matterId: string; exportId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId, exportId } = req.params;

    const rows = await withOrgSession(orgId, (client) =>
      client.query<ExportRow>("SELECT id, kind, status, error, result_s3_key FROM matter_exports WHERE id = $1 AND matter_id = $2", [
        exportId,
        matterId,
      ]),
    );
    if (rows.rowCount === 0) {
      res.status(404).json({ error: "Export not found" });
      return;
    }

    const row = rows.rows[0];
    res.json({ exportId: row.id, kind: row.kind, status: row.status, error: row.error });
  } catch (err) {
    next(err);
  }
});

// Presigned GET, exactly like documents.ts's view-url route — 409 if the
// worker hasn't finished yet, 404 if the job doesn't exist (or belongs to
// another matter/org).
exportsRouter.get("/:exportId/download-url", async (req: Request<{ matterId: string; exportId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId, exportId } = req.params;

    const rows = await withOrgSession(orgId, (client) =>
      client.query<ExportRow>("SELECT id, kind, status, error, result_s3_key FROM matter_exports WHERE id = $1 AND matter_id = $2", [
        exportId,
        matterId,
      ]),
    );
    if (rows.rowCount === 0) {
      res.status(404).json({ error: "Export not found" });
      return;
    }

    const row = rows.rows[0];
    if (row.status !== "ready" || !row.result_s3_key) {
      res.status(409).json({ error: "Export is not ready yet" });
      return;
    }

    const downloadUrl = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: row.result_s3_key }), {
      expiresIn: 900,
    });

    res.json({ downloadUrl });
  } catch (err) {
    next(err);
  }
});
