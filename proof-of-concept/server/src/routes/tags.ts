import { Router } from "express";
import { getDb, type TagRow } from "../db.js";

export const tagsRouter = Router();

tagsRouter.get("/", (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM tags ORDER BY is_custom ASC, name ASC").all() as unknown as TagRow[];
  res.json(rows);
});

tagsRouter.post("/", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  const color = typeof req.body?.color === "string" ? req.body.color : "#5B6272";

  const existing = getDb().prepare("SELECT * FROM tags WHERE name = ?").get(name) as unknown as TagRow | undefined;
  if (existing) return res.json(existing);

  const info = getDb().prepare("INSERT INTO tags (name, color, is_custom) VALUES (?, ?, 1)").run(name, color);
  const row = getDb().prepare("SELECT * FROM tags WHERE id = ?").get(info.lastInsertRowid) as unknown as TagRow;
  res.status(201).json(row);
});

// POST /api/tags/apply { guids: string[], tagId: number }
tagsRouter.post("/apply", (req, res) => {
  const guids: unknown = req.body?.guids;
  const tagId: unknown = req.body?.tagId;
  if (!Array.isArray(guids) || typeof tagId !== "number") {
    return res.status(400).json({ error: "Body must be { guids: string[], tagId: number }" });
  }
  const insert = getDb().prepare(
    "INSERT INTO document_tags (document_guid, tag_id) VALUES (?, ?) ON CONFLICT(document_guid, tag_id) DO NOTHING",
  );
  for (const guid of guids as string[]) insert.run(guid, tagId);
  res.json({ ok: true });
});

// POST /api/tags/remove { guids: string[], tagId: number }
tagsRouter.post("/remove", (req, res) => {
  const guids: unknown = req.body?.guids;
  const tagId: unknown = req.body?.tagId;
  if (!Array.isArray(guids) || typeof tagId !== "number") {
    return res.status(400).json({ error: "Body must be { guids: string[], tagId: number }" });
  }
  const del = getDb().prepare("DELETE FROM document_tags WHERE document_guid = ? AND tag_id = ?");
  for (const guid of guids as string[]) del.run(guid, tagId);
  res.json({ ok: true });
});
