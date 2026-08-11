import { Router } from "express";
import multer from "multer";
import { getDocumentStore } from "../storage/index.js";
import { verifyLocalDownload } from "../storage/signedUrl.js";
import { MatterNotFoundOrNoAccess, uploadDocument } from "../documents/uploadDocument.js";
import { logAuditForRequest } from "../audit/log.js";

export const documentsRouter = Router();
export const localDownloadRouter = Router();

// Sized to a matter's entire storage allowance (5GB, security white paper
// Section 9) — a single container export (a large .zip/.pst, once cloud-backend
// supports expanding those) is the one realistic case that needs to approach
// that ceiling, not routine individual documents. Enforced here as a hard
// stop; how much of it a real upload actually gets through is bounded
// separately by memory (the whole file is buffered in-process, see
// uploadDocument.ts) and by CloudFront's own request-body limit in front of
// this API — the size warning surfaced in the web client's uploader exists
// because of those two, not this number.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

/**
 * Uploads a file into a matter (Section 2.2/3.3). Allocates the matter's
 * next sequential GUID, writes the raw bytes into the Secure Document
 * Repository, inserts the document row, and enqueues an extraction job —
 * mirroring the desktop prototype's ingest flow, just server-side.
 */
documentsRouter.post("/matters/:matterId/documents", upload.single("file"), async (req, res) => {
  const matterId = String(req.params.matterId);
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "file is required (multipart field 'file')" });
    return;
  }

  try {
    const document = await uploadDocument(req.tenant!, matterId, file);
    logAuditForRequest(req, {
      matterId,
      action: "document.upload",
      allowed: true,
      detail: { documentId: document.id, filename: file.originalname },
    });
    res.status(201).json(document);
  } catch (err) {
    if (err instanceof MatterNotFoundOrNoAccess) {
      logAuditForRequest(req, {
        matterId,
        action: "document.upload",
        allowed: false,
        detail: { filename: file.originalname, reason: "not_found_or_no_access" },
      });
      res.status(404).json({ error: "not_found_or_no_access" });
      return;
    }
    console.error("upload failed:", err);
    res.status(500).json({ error: "upload_failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

const DOCUMENT_LIST_COLUMNS = "id, guid, filename, status, size_bytes, created_at";

async function tagsByDocumentId(
  client: import("pg").PoolClient,
  documentIds: string[],
): Promise<Map<string, Array<{ id: string; name: string; color: string | null }>>> {
  const map = new Map<string, Array<{ id: string; name: string; color: string | null }>>();
  if (documentIds.length === 0) return map;
  const { rows } = await client.query(
    `SELECT dt.document_id, t.id, t.name, t.color
     FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
     WHERE dt.document_id = ANY($1)
     ORDER BY t.name`,
    [documentIds],
  );
  for (const row of rows) {
    const list = map.get(row.document_id) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    map.set(row.document_id, list);
  }
  return map;
}

/** Lists documents in a matter — RLS (documents_select) is what actually enforces access. */
documentsRouter.get("/matters/:matterId/documents", async (req, res) => {
  const { matterId } = req.params;
  const rows = await req.withTenant!(async (client) => {
    const { rows } = await client.query(
      `SELECT ${DOCUMENT_LIST_COLUMNS} FROM documents WHERE matter_id = $1 ORDER BY guid`,
      [matterId],
    );
    const tagMap = await tagsByDocumentId(client, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] }));
  });
  res.json(rows);
});

/**
 * Full-text search within a matter. websearch_to_tsquery gives users
 * intuitive Boolean-ish syntax (quoted phrases, "-" to exclude) without
 * needing to teach them Postgres's tsquery operators directly — matter/group
 * access is the same RLS as the list endpoint above, search adds nothing new
 * to the trust boundary.
 */
documentsRouter.get("/matters/:matterId/documents/search", async (req, res) => {
  const { matterId } = req.params;
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.status(400).json({ error: "q is required" });
    return;
  }
  const rows = await req.withTenant!(async (client) => {
    const { rows } = await client.query(
      `SELECT ${DOCUMENT_LIST_COLUMNS}, ts_rank(search_vector, websearch_to_tsquery('english', $2)) AS rank
       FROM documents
       WHERE matter_id = $1 AND search_vector @@ websearch_to_tsquery('english', $2)
       ORDER BY rank DESC`,
      [matterId, q],
    );
    const tagMap = await tagsByDocumentId(client, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] }));
  });
  res.json(rows);
});

documentsRouter.get("/documents/:id", async (req, res) => {
  const { id } = req.params;
  const document = await req.withTenant!(async (client) => {
    const { rows } = await client.query(
      "SELECT id, matter_id, guid, filename, status, extracted_text, extraction_error, size_bytes, created_at FROM documents WHERE id = $1",
      [id],
    );
    if (rows.length === 0) return undefined;
    const tagMap = await tagsByDocumentId(client, [rows[0].id]);
    return { ...rows[0], tags: tagMap.get(rows[0].id) ?? [] };
  });
  if (!document) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(document);
});

/** Issues a short-lived download URL (real presigned URL on S3, signed local route in dev). */
documentsRouter.post("/documents/:id/download-url", async (req, res) => {
  const { id } = req.params;
  const row = await req.withTenant!(async (client) => {
    const { rows } = await client.query("SELECT storage_key, matter_id FROM documents WHERE id = $1", [id]);
    return rows[0] as { storage_key: string; matter_id: string } | undefined;
  });
  if (!row) {
    logAuditForRequest(req, {
      action: "document.download",
      allowed: false,
      detail: { documentId: id, reason: "not_found" },
    });
    res.status(404).json({ error: "not_found" });
    return;
  }
  const url = await getDocumentStore().getDownloadUrl(row.storage_key, { expiresInSeconds: 300 });
  logAuditForRequest(req, { matterId: row.matter_id, action: "document.download", allowed: true, detail: { documentId: id } });
  res.json({ url, expiresInSeconds: 300 });
});

/**
 * Local-dev-only download route the signed URL above points at when
 * DOCUMENT_STORE=local. Deliberately outside the requireAuth/resolveTenant
 * chain (mounted separately in src/index.ts) — a real presigned S3 URL
 * doesn't carry an Auth0 bearer token either, its security is the signature
 * + expiry, which this route verifies itself.
 */
localDownloadRouter.get("/documents/local-download", async (req, res) => {
  const key = String(req.query.key ?? "");
  const expires = Number(req.query.expires ?? 0);
  const token = String(req.query.token ?? "");
  if (!key || !expires || !token || !verifyLocalDownload(key, expires, token)) {
    res.status(403).json({ error: "invalid_or_expired_link" });
    return;
  }
  try {
    const data = await getDocumentStore().get(key);
    res.setHeader("Content-Disposition", `attachment; filename="${key.split("/").pop()}"`);
    res.send(data);
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});
