import { Router } from "express";
import { ZipArchive } from "archiver";
import { getDb, type DocumentRow } from "../db.js";

export const exportRouter = Router();

function docsForGuids(guids: string[]): DocumentRow[] {
  if (guids.length === 0) return [];
  const placeholders = guids.map(() => "?").join(",");
  return getDb().prepare(`SELECT * FROM documents WHERE guid IN (${placeholders})`).all(...guids) as unknown as DocumentRow[];
}

function tagNamesForGuid(guid: string): string {
  const rows = getDb()
    .prepare(
      `SELECT t.name as name FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_guid = ? ORDER BY t.name`,
    )
    .all(guid) as Array<{ name: string }>;
  return rows.map((r) => r.name).join("; ");
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// POST /api/export/zip { guids: string[] } — documents renamed to GUID.ext
exportRouter.post("/zip", (req, res) => {
  const guids: unknown = req.body?.guids;
  if (!Array.isArray(guids) || guids.length === 0) {
    return res.status(400).json({ error: "Body must be { guids: string[] } with at least one guid" });
  }
  const docs = docsForGuids(guids as string[]);

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="edd-export-${Date.now()}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (err) => res.status(500).end(String(err)));
  archive.pipe(res);

  for (const doc of docs) {
    const outName = doc.extension ? `${doc.guid}.${doc.extension}` : doc.guid;
    archive.file(doc.stored_path, { name: outName });
  }

  archive.finalize();
});

// POST /api/export/csv { guids: string[] } — metadata table for the given GUIDs
exportRouter.post("/csv", (req, res) => {
  const guids: unknown = req.body?.guids;
  if (!Array.isArray(guids) || guids.length === 0) {
    return res.status(400).json({ error: "Body must be { guids: string[] } with at least one guid" });
  }
  const docs = docsForGuids(guids as string[]);
  const byGuid = new Map(docs.map((d) => [d.guid, d]));
  const ordered = (guids as string[]).map((g) => byGuid.get(g)).filter((d): d is DocumentRow => !!d);

  const header = [
    "GUID",
    "Original Filename",
    "Extension",
    "Size (bytes)",
    "Date Modified",
    "Date Created",
    "Title",
    "Author",
    "Subject",
    "Tags",
    "Family ID",
    "Parent GUID",
    "Family Depth",
    "Imported At",
  ];
  const lines = [header.join(",")];
  for (const d of ordered) {
    lines.push(
      [
        d.guid,
        d.original_name,
        d.extension,
        String(d.size_bytes),
        d.date_modified ?? "",
        d.date_created ?? "",
        d.title ?? "",
        d.author ?? "",
        d.subject ?? "",
        tagNamesForGuid(d.guid),
        d.family_id ?? "",
        d.parent_guid ?? "",
        String(d.depth),
        d.imported_at,
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="edd-metadata-${Date.now()}.csv"`);
  res.send(lines.join("\r\n"));
});
