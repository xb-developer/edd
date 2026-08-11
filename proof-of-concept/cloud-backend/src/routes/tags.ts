import { Router } from "express";
import { logAuditForRequest } from "../audit/log.js";

export const tagsRouter = Router();

/** Creates a tag in the caller's org-wide shared vocabulary (Section 4/migration 003). */
tagsRouter.post("/tags", async (req, res) => {
  const { name, color } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const tag = await req.withTenant!(async (client) => {
      const { rows } = await client.query(
        "INSERT INTO tags (organization_id, name, color, created_by_user_id) VALUES ($1, $2, $3, $4) RETURNING id, name, color, created_at",
        [req.tenant!.organizationId, name, color ?? null, req.tenant!.userId],
      );
      return rows[0];
    });
    res.status(201).json(tag);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("tags_organization_id_name_key")) {
      res.status(409).json({ error: "tag_already_exists" });
      return;
    }
    console.error("tag creation failed:", err);
    res.status(500).json({ error: "tag_creation_failed", detail: message });
  }
});

/** Lists the caller's org-wide tag vocabulary. */
tagsRouter.get("/tags", async (req, res) => {
  const rows = await req.withTenant!(async (client) => {
    const { rows } = await client.query(
      "SELECT id, name, color, created_at FROM tags WHERE organization_id = $1 ORDER BY name",
      [req.tenant!.organizationId],
    );
    return rows;
  });
  res.json(rows);
});

/**
 * Applies a tag to a document. group_id is read from the document itself
 * (not trusted from the request body) so document_tags_insert's RLS check
 * lines up with whatever group the document actually belongs to.
 */
tagsRouter.post("/documents/:documentId/tags", async (req, res) => {
  const { documentId } = req.params;
  const { tagId } = req.body ?? {};
  if (!tagId) {
    res.status(400).json({ error: "tagId is required" });
    return;
  }
  try {
    const matterId = await req.withTenant!(async (client) => {
      const doc = await client.query("SELECT organization_id, group_id, matter_id FROM documents WHERE id = $1", [documentId]);
      if (doc.rowCount === 0) {
        throw Object.assign(new Error("not_found"), { status: 404 });
      }
      const { organization_id, group_id, matter_id } = doc.rows[0];
      await client.query(
        `INSERT INTO document_tags (document_id, tag_id, organization_id, group_id, applied_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [documentId, tagId, organization_id, group_id, req.tenant!.userId],
      );
      return matter_id as string;
    });
    logAuditForRequest(req, { matterId, action: "tag.apply", allowed: true, detail: { documentId, tagId } });
    res.status(204).end();
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) console.error("tag apply failed:", err);
    if (status === 404) {
      logAuditForRequest(req, { action: "tag.apply", allowed: false, detail: { documentId, tagId, reason: "not_found" } });
    }
    res.status(status).json({
      error: status === 404 ? "not_found" : "tag_apply_failed",
      ...(status >= 500 ? { detail: err instanceof Error ? err.message : String(err) } : {}),
    });
  }
});

/** Removes a tag from a document — any current group member can, not only whoever applied it. */
tagsRouter.delete("/documents/:documentId/tags/:tagId", async (req, res) => {
  const { documentId, tagId } = req.params;
  await req.withTenant!(async (client) => {
    await client.query("DELETE FROM document_tags WHERE document_id = $1 AND tag_id = $2", [documentId, tagId]);
  });
  res.status(204).end();
});
