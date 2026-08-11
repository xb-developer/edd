import { Router } from "express";
import { stat, copyFile, mkdir, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import {
  getDb,
  nextGuid,
  getFilesDir,
  indexDocumentText,
  removeDocumentText,
  searchDocumentGuids,
  removeChunks,
  enqueueEmbedding,
  removeFromEmbeddingQueue,
  type DocumentRow,
  type TagRow,
} from "../db.js";
import type { ExtractedMetadata } from "../lib/metadata.js";
import { extractInPool, getExtractPoolSize } from "../lib/extractPool.js";
import { extractZipMembers, extractEmailAttachments, extractMboxMembers } from "../lib/familyExtract.js";
import { extractPstMembers } from "../lib/pstExtract.js";

export const documentsRouter = Router();

interface DocumentDTO {
  guid: string;
  originalName: string;
  extension: string;
  sizeBytes: number;
  dateModified: string | null;
  dateCreated: string | null;
  title: string | null;
  author: string | null;
  subject: string | null;
  extra: Record<string, unknown> | null;
  importedAt: string;
  familyId: string | null;
  parentGuid: string | null;
  depth: number;
  to: string | null;
  cc: string | null;
  tags: Array<{ id: number; name: string; color: string }>;
}

function tagsForGuids(guids: string[]): Map<string, Array<{ id: number; name: string; color: string }>> {
  const map = new Map<string, Array<{ id: number; name: string; color: string }>>();
  if (guids.length === 0) return map;
  const placeholders = guids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT dt.document_guid as guid, t.id as id, t.name as name, t.color as color
       FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
       WHERE dt.document_guid IN (${placeholders})`,
    )
    .all(...guids) as Array<{ guid: string; id: number; name: string; color: string }>;
  for (const r of rows) {
    const list = map.get(r.guid) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    map.set(r.guid, list);
  }
  return map;
}

function toDto(row: DocumentRow, tags: Array<{ id: number; name: string; color: string }>): DocumentDTO {
  return {
    guid: row.guid,
    originalName: row.original_name,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    dateModified: row.date_modified,
    dateCreated: row.date_created,
    title: row.title,
    author: row.author,
    subject: row.subject,
    extra: row.extra_json ? JSON.parse(row.extra_json) : null,
    importedAt: row.imported_at,
    familyId: row.family_id,
    parentGuid: row.parent_guid,
    depth: row.depth,
    to: row.to_addresses,
    cc: row.cc_addresses,
    tags,
  };
}

// GET /api/documents?tags=1,2&mode=all|any&q=search
documentsRouter.get("/", (req, res) => {
  // Keep original casing for FTS5 — its boolean operators (AND/OR/NOT) are
  // case-sensitive, so lowercasing here would silently turn them into
  // literal search terms instead of operators.
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const tagIds = typeof req.query.tags === "string" && req.query.tags.length > 0
    ? req.query.tags.split(",").map(Number).filter((n) => Number.isFinite(n))
    : [];
  const mode = req.query.mode === "all" ? "all" : "any";

  let rows = getDb().prepare("SELECT * FROM documents ORDER BY guid ASC").all() as unknown as DocumentRow[];

  if (q) {
    // Boolean/phrase full-text search (AND/OR/NOT, "phrase", prefix*) against
    // extracted body text + title/author, plus a plain filename substring
    // match so a search for a filename still works even if FTS finds nothing.
    const ftsGuids = searchDocumentGuids(q);
    const qLower = q.toLowerCase();
    rows = rows.filter((r) => ftsGuids.has(r.guid) || r.original_name.toLowerCase().includes(qLower));
  }

  const guids = rows.map((r) => r.guid);
  const tagMap = tagsForGuids(guids);

  if (tagIds.length > 0) {
    rows = rows.filter((r) => {
      const rowTagIds = (tagMap.get(r.guid) ?? []).map((t) => t.id);
      if (mode === "all") return tagIds.every((id) => rowTagIds.includes(id));
      return tagIds.some((id) => rowTagIds.includes(id));
    });
  }

  res.json(rows.map((r) => toDto(r, tagMap.get(r.guid) ?? [])));
});

documentsRouter.get("/:guid", (req, res) => {
  const row = getDb().prepare("SELECT * FROM documents WHERE guid = ?").get(req.params.guid) as unknown as DocumentRow | undefined;
  if (!row) return res.status(404).json({ error: "Document not found" });
  const tags = tagsForGuids([row.guid]).get(row.guid) ?? [];
  res.json(toDto(row, tags));
});

interface ImportResult {
  imported: DocumentDTO[];
  errors: Array<{ path: string; error: string }>;
}

interface FamilyContext {
  familyId: string | null;
  parentGuid: string | null;
  depth: number;
}

interface DiscoveredNode {
  sourcePath: string;
  originalName: string;
  extension: string;
  stats: Stats;
  meta: ExtractedMetadata;
  children: DiscoveredNode[];
  // An mbox export is just a bulk transport format, not a document with its
  // own evidentiary meaning (unlike a zip or a PST, which are often
  // themselves referenced as produced items) — so it's never written as a
  // document row. Its children are promoted straight into the position it
  // would have occupied (same parent/family/depth), rather than being
  // nested one level under it.
  transparent: boolean;
}

const RECURSIVE_EXTS = new Set(["zip", "eml", "msg", "pst", "ost", "mbox"]);
// Guards against pathological nesting (e.g. a zip that somehow contains
// itself) rather than any realistic document family.
const MAX_DEPTH = 12;

// A container's children must NOT all be kicked off via a single
// Promise.all — that fires every child's discoverNode call (Piscina task
// submission, mailparser parse, temp-file I/O) simultaneously. A zip with a
// few dozen members is fine, but a real-world PST can hold thousands of
// messages: unbounded fan-out there queued so much in-flight work at once
// that a single ~450MB PST ballooned to multiple GB of memory and stalled
// indefinitely. Bounding it to the extraction pool's actual size keeps
// memory proportional to real processing capacity instead of container size.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------
// Pass 1 — discover: extraction (mammoth/xlsx/OCR/etc, via the worker
// pool) and zip/email expansion for the WHOLE batch, fully in parallel.
// No DB writes happen here, so there is no GUID ordering to preserve yet
// — this is what actually gets the benefit of more than one CPU core.
// ---------------------------------------------------------------------
async function discoverNode(
  sourcePath: string,
  originalNameOverride: string | undefined,
  depth: number,
  errors: ImportResult["errors"],
  cleanupFns: Array<() => Promise<void>>,
): Promise<DiscoveredNode | null> {
  const originalName = originalNameOverride ?? path.basename(sourcePath);
  try {
    const stats = await stat(sourcePath);
    if (!stats.isFile()) throw new Error("Not a file");

    const extension = path.extname(originalName).replace(/^\./, "").toLowerCase();
    const meta = await extractInPool(sourcePath, extension);
    // mbox/pst/ost are all bulk mail-export containers, not documents in
    // their own right — unlike a zip (which can genuinely be "the produced
    // item") or an eml/msg (which IS the email under review).
    const TRANSPARENT_EXTS = new Set(["mbox", "pst", "ost"]);
    const node: DiscoveredNode = { sourcePath, originalName, extension, stats, meta, children: [], transparent: TRANSPARENT_EXTS.has(extension) };

    if (RECURSIVE_EXTS.has(extension) && depth < MAX_DEPTH) {
      let extraction;
      if (extension === "zip") extraction = await extractZipMembers(sourcePath);
      else if (extension === "pst" || extension === "ost") extraction = await extractPstMembers(sourcePath);
      else if (extension === "mbox") extraction = await extractMboxMembers(sourcePath);
      else extraction = await extractEmailAttachments(sourcePath, extension);
      // Cleanup (deletes the temp staging dir) can't run until Pass 2 has
      // copied these children into permanent storage, so it's collected
      // and run once at the very end instead of right after this node.
      cleanupFns.push(extraction.cleanup);
      const childNodes = await mapWithConcurrency(extraction.children, getExtractPoolSize(), (c) =>
        discoverNode(c.tempPath, c.originalName, depth + 1, errors, cleanupFns),
      );
      node.children = childNodes.filter((n): n is DiscoveredNode => n !== null);
    }

    return node;
  } catch (err) {
    errors.push({ path: originalName, error: (err as Error).message });
    return null;
  }
}

function countTree(node: DiscoveredNode): number {
  return (node.transparent ? 0 : 1) + node.children.reduce((sum, c) => sum + countTree(c), 0);
}

// ---------------------------------------------------------------------
// Pass 2 — commit: walk the discovered tree depth-first, allocating
// GUIDs and writing to the DB strictly in that order, so families stay
// numbered contiguously (parent, every descendant, then the next
// top-level import). This is the cheap part — SQLite inserts and file
// copies — so doing it serially costs almost nothing next to what
// Pass 1 just saved by running in parallel.
// ---------------------------------------------------------------------
async function commitNode(
  node: DiscoveredNode,
  ctx: FamilyContext,
  filesDir: string,
  result: ImportResult,
): Promise<void> {
  const { originalName, extension, stats, meta } = node;

  // A transparent container (mbox) gets no document row of its own — its
  // children are committed directly into the position it would have
  // occupied. At the top level that means each extracted message becomes
  // an independent family root rather than everything sharing the mbox's
  // family_id.
  if (node.transparent) {
    for (const child of node.children) {
      await commitNode(child, ctx, filesDir, result);
    }
    return;
  }

  try {
    const guid = nextGuid();
    // A top-level import is the root of its own family; a child inherits
    // its family from the parent, so grandchildren stay linked to the same
    // family as the original zip/email.
    const familyId = ctx.familyId ?? guid;
    const storedName = extension ? `${guid}.${extension}` : guid;
    const storedPath = path.join(filesDir, storedName);

    await copyFile(node.sourcePath, storedPath);

    const importedAt = new Date().toISOString();

    getDb()
      .prepare(
        `INSERT INTO documents
          (guid, original_name, extension, stored_path, size_bytes, date_modified, date_created, title, author, subject, extra_json, imported_at, family_id, parent_guid, depth, to_addresses, cc_addresses)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        guid,
        originalName,
        extension,
        storedPath,
        stats.size,
        meta.dateModified,
        meta.dateCreated,
        meta.title,
        meta.author,
        meta.subject,
        meta.extra ? JSON.stringify(meta.extra) : null,
        importedAt,
        familyId,
        ctx.parentGuid,
        ctx.depth,
        meta.to,
        meta.cc,
      );

    indexDocumentText(guid, meta.title, meta.author, meta.text);
    // RAG embedding is enqueued, not awaited here — a slow/busy Ollama must
    // never be able to stall ingest. A background loop drains this queue
    // independently (see lib/embeddingWorker.ts).
    if (meta.text) enqueueEmbedding(guid, meta.text);

    result.imported.push(
      toDto(
        {
          guid,
          original_name: originalName,
          extension,
          stored_path: storedPath,
          size_bytes: stats.size,
          date_modified: meta.dateModified,
          date_created: meta.dateCreated,
          title: meta.title,
          author: meta.author,
          subject: meta.subject,
          extra_json: meta.extra ? JSON.stringify(meta.extra) : null,
          imported_at: importedAt,
          family_id: familyId,
          parent_guid: ctx.parentGuid,
          depth: ctx.depth,
          to_addresses: meta.to,
          cc_addresses: meta.cc,
        },
        [],
      ),
    );

    for (const child of node.children) {
      await commitNode(child, { familyId, parentGuid: guid, depth: ctx.depth + 1 }, filesDir, result);
    }
  } catch (err) {
    result.errors.push({ path: originalName, error: (err as Error).message });
  }
}

// The client now fires several /import requests concurrently to keep the
// worker pool fed. Pass 1 (discovery/extraction) is fine to run fully in
// parallel across requests — it never touches the DB. Pass 2 (GUID
// allocation + insert) is NOT: two requests committing at the same time
// would interleave their families' GUIDs and break the contiguous
// numbering guarantee. This module-level queue serializes just that step
// across every concurrent request in this process, while leaving Pass 1
// unblocked.
let commitQueue: Promise<void> = Promise.resolve();
function withCommitLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = commitQueue.then(fn, fn);
  commitQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

documentsRouter.post("/import", async (req, res) => {
  const paths: unknown = req.body?.paths;
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
    return res.status(400).json({ error: "Body must be { paths: string[] }" });
  }

  const filesDir = getFilesDir();
  await mkdir(filesDir, { recursive: true });

  const result: ImportResult = { imported: [], errors: [] };
  const cleanupFns: Array<() => Promise<void>> = [];
  const startedAt = Date.now();

  const trees = await mapWithConcurrency(paths as string[], getExtractPoolSize(), (p) =>
    discoverNode(p, undefined, 0, result.errors, cleanupFns),
  );

  try {
    await withCommitLock(async () => {
      for (const tree of trees) {
        if (tree) await commitNode(tree, { familyId: null, parentGuid: null, depth: 0 }, filesDir, result);
      }
    });
  } finally {
    await Promise.all(cleanupFns.map((fn) => fn().catch(() => {})));
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const fileCount = trees.reduce((sum, t) => sum + (t ? countTree(t) : 0), 0);
  if (fileCount > 0) {
    console.log(
      `Import: ${fileCount} documents in ${elapsedSec.toFixed(2)}s ` +
        `(${(fileCount / elapsedSec).toFixed(1)} files/sec, extract pool size ${getExtractPoolSize()})`,
    );
  }

  res.json(result);
});

documentsRouter.delete("/:guid", async (req, res) => {
  const row = getDb().prepare("SELECT * FROM documents WHERE guid = ?").get(req.params.guid) as unknown as DocumentRow | undefined;
  if (!row) return res.status(404).json({ error: "Document not found" });
  getDb().prepare("DELETE FROM document_tags WHERE document_guid = ?").run(row.guid);
  getDb().prepare("DELETE FROM documents WHERE guid = ?").run(row.guid);
  removeDocumentText(row.guid);
  removeChunks(row.guid);
  removeFromEmbeddingQueue(row.guid);
  await unlink(row.stored_path).catch(() => {});
  res.json({ ok: true });
});
