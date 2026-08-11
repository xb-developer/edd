import { Router, type Request } from "express";
import { withOrgSession } from "@xbundle/edd-workbench-core";
import { requireRole } from "../auth.js";

// mergeParams — mounted at /api/matters/:matterId/document-tags (see index.ts).
export const documentTagsRouter = Router({ mergeParams: true });

// Bulk map, no role gate — litigation_support still needs to see applied
// coding state. Backs FilterPanel's tag-filter counts.
documentTagsRouter.get("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId } = req.params;

    const rows = await withOrgSession(orgId, (client) =>
      client.query<{ document_id: string; tag_id: string }>(
        "SELECT document_id, tag_id FROM document_tags WHERE matter_id = $1",
        [matterId],
      ),
    );

    const byDocument: Record<string, string[]> = {};
    for (const row of rows.rows) {
      (byDocument[row.document_id] ??= []).push(row.tag_id);
    }
    res.json(byDocument);
  } catch (err) {
    next(err);
  }
});

documentTagsRouter.get("/:documentId", async (req: Request<{ matterId: string; documentId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId, documentId } = req.params;

    const rows = await withOrgSession(orgId, (client) =>
      client.query<{ tag_id: string }>(
        "SELECT tag_id FROM document_tags WHERE matter_id = $1 AND document_id = $2",
        [matterId, documentId],
      ),
    );
    res.json(rows.rows.map((r) => r.tag_id));
  } catch (err) {
    next(err);
  }
});

// documentIds is always an array — the same endpoint serves both the
// existing single-document toggle (client sends [documentId]) and the new
// bulk-apply case (client sends every checked id). No separate single-doc
// method exists.
documentTagsRouter.post("/apply", requireRole("admin", "reviewer"), async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { matterId } = req.params;
    const { documentIds, tagId } = req.body as { documentIds?: string[]; tagId?: string };
    if (!documentIds?.length || !tagId) {
      res.status(400).json({ error: "documentIds and tagId are required" });
      return;
    }

    await withOrgSession(orgId, async (client) => {
      const tagExists = await client.query("SELECT id FROM tags WHERE id = $1 AND matter_id = $2", [tagId, matterId]);
      if (tagExists.rowCount === 0) {
        const err = new Error("Tag not found in this matter") as Error & { status: number };
        err.status = 404;
        throw err;
      }

      // The WHERE d.matter_id = $1 AND d.id = ANY($5) join is what
      // silently drops a smuggled cross-matter documentId rather than
      // rejecting the whole batch with a composite-FK violation.
      await client.query(
        `INSERT INTO document_tags (document_id, tag_id, org_id, matter_id, applied_by)
         SELECT d.id, $2, $3, $1, $4
         FROM documents d
         WHERE d.matter_id = $1 AND d.id = ANY($5::uuid[])
         ON CONFLICT (document_id, tag_id) DO NOTHING`,
        [matterId, tagId, orgId, userId, documentIds],
      );
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

documentTagsRouter.post("/remove", requireRole("admin", "reviewer"), async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId } = req.params;
    const { documentIds, tagId } = req.body as { documentIds?: string[]; tagId?: string };
    if (!documentIds?.length || !tagId) {
      res.status(400).json({ error: "documentIds and tagId are required" });
      return;
    }

    await withOrgSession(orgId, (client) =>
      client.query(
        "DELETE FROM document_tags WHERE matter_id = $1 AND tag_id = $2 AND document_id = ANY($3::uuid[])",
        [matterId, tagId, documentIds],
      ),
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
