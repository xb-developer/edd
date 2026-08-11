import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Router } from "express";
import { PDFDocument } from "pdf-lib";
import { db, type DocumentRow } from "../db.js";

export const documentsRouter = Router();

function nextStagingOrder(): number {
  const row = db.prepare("SELECT MAX(display_order) as maxOrder FROM documents WHERE tab_id IS NULL").get() as
    | { maxOrder: number | null }
    | undefined;
  return (row?.maxOrder ?? -1) + 1;
}

// Import files from the filesystem (paths come from the Electron native
// multi-file picker) — each becomes a Document in the staging pool, not
// placed into any bundle/tab yet. Mirrors old Assemble's staging-pool-then-
// place import pattern.
documentsRouter.post("/import", async (req, res) => {
  const { filePaths } = req.body as { filePaths?: string[] };
  if (!filePaths || filePaths.length === 0) {
    res.status(400).json({ error: "filePaths is required" });
    return;
  }

  const created: DocumentRow[] = [];
  let order = nextStagingOrder();

  for (const filePath of filePaths) {
    try {
      const bytes = await readFile(filePath);
      const pdf = await PDFDocument.load(bytes);
      const pageCount = pdf.getPageCount();
      const title = path.basename(filePath, path.extname(filePath));
      const id = randomUUID();
      const addedAt = new Date().toISOString();

      db.prepare(
        "INSERT INTO documents (id, title, date, source_path, page_count, tab_id, display_order, added_at) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)",
      ).run(id, title, filePath, pageCount, order, addedAt);

      created.push({ id, title, date: null, source_path: filePath, page_count: pageCount, tab_id: null, display_order: order, added_at: addedAt });
      order += 1;
    } catch (err) {
      console.error(`Failed to import ${filePath}:`, err);
      // Skip files that fail to parse as PDF — walking-skeleton MVP is PDF-only.
    }
  }

  res.status(201).json(created);
});

documentsRouter.patch("/:id", (req, res) => {
  const { title, date } = req.body as { title?: string; date?: string | null };
  const existing = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id) as DocumentRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  db.prepare("UPDATE documents SET title = ?, date = ? WHERE id = ?").run(
    title ?? existing.title,
    date === undefined ? existing.date : date,
    req.params.id,
  );
  res.json(db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id));
});

documentsRouter.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM documents WHERE id = ?").run(req.params.id);
  res.status(204).send();
});
