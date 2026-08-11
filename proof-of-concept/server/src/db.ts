import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT_DIR = path.join(homedir(), "AppData", "Roaming", "EDD Workbench");
const MATTERS_DIR = path.join(ROOT_DIR, "matters");
const CATALOG_PATH = path.join(ROOT_DIR, "matters.json");

mkdirSync(MATTERS_DIR, { recursive: true });

export interface MatterInfo {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

interface Catalog {
  lastOpenedId: string | null;
  matters: MatterInfo[];
}

function readCatalog(): Catalog {
  if (!existsSync(CATALOG_PATH)) return { lastOpenedId: null, matters: [] };
  try {
    return JSON.parse(readFileSync(CATALOG_PATH, "utf-8")) as Catalog;
  } catch {
    return { lastOpenedId: null, matters: [] };
  }
}

function writeCatalog(catalog: Catalog): void {
  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), "utf-8");
}

// Every catalog write goes through here: read-fresh-then-mutate-then-write,
// as one synchronous unit with no I/O in between. Within a single process
// that's already race-free (Node's single-threaded, and these are sync fs
// calls, so no other request can interleave mid-function). It's not race-free
// across two separate OS processes pointed at the same catalog file — but
// that scenario is now prevented at the source by requestSingleInstanceLock()
// in electron/main.ts. This helper is defense in depth: it guarantees every
// mutation starts from the current on-disk state rather than a snapshot
// taken earlier, so even a stray second process reading, waiting, then
// writing can only ever lose its own change, not anyone else's.
function mutateCatalog<T>(fn: (catalog: Catalog) => T): T {
  const catalog = readCatalog();
  const result = fn(catalog);
  writeCatalog(catalog);
  return result;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "matter") + "-" + randomUUID().slice(0, 6);
}

let db: DatabaseSync | undefined;
let activeMatter: MatterInfo | undefined;
let activeFilesDir: string | undefined;

export function getDb(): DatabaseSync {
  if (!db) throw new Error("No matter is open");
  return db;
}

export function getFilesDir(): string {
  if (!activeFilesDir) throw new Error("No matter is open");
  return activeFilesDir;
}

export function getActiveMatter(): MatterInfo | undefined {
  return activeMatter;
}

export function listMatters(): MatterInfo[] {
  return readCatalog().matters;
}

export function createMatter(name: string): MatterInfo {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Matter name is required");
  const id = slugify(trimmed);
  const matterPath = path.join(MATTERS_DIR, id);
  mkdirSync(matterPath, { recursive: true });

  const info: MatterInfo = { id, name: trimmed, path: matterPath, createdAt: new Date().toISOString() };
  mutateCatalog((catalog) => catalog.matters.push(info));

  openMatter(id);
  return info;
}

export function openMatter(id: string): MatterInfo {
  // Look the matter up on its own fresh read first — if `id` doesn't exist,
  // fail before touching the db connection or recording it as last-opened.
  const info = readCatalog().matters.find((m) => m.id === id);
  if (!info) throw new Error(`Unknown matter: ${id}`);

  db?.close();

  const filesDir = path.join(info.path, "files");
  mkdirSync(filesDir, { recursive: true });

  db = new DatabaseSync(path.join(info.path, "edd.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  initSchema(db);

  activeMatter = info;
  activeFilesDir = filesDir;

  mutateCatalog((catalog) => {
    catalog.lastOpenedId = id;
  });

  return info;
}

export function getLastOpenedMatterId(): string | null {
  return readCatalog().lastOpenedId;
}

// Permanently removes a matter: its SQLite database, every imported
// document file, and its catalog entry. If it's the currently open matter,
// the db connection is closed first — Windows won't let a directory be
// removed while a file inside it (edd.sqlite) is still held open, and
// leaving `db`/`activeMatter` pointing at now-deleted state would let
// later requests operate on a matter that no longer exists.
export function deleteMatter(id: string): void {
  const info = readCatalog().matters.find((m) => m.id === id);
  if (!info) throw new Error(`Unknown matter: ${id}`);

  if (activeMatter?.id === id) {
    db?.close();
    db = undefined;
    activeMatter = undefined;
    activeFilesDir = undefined;
  }

  rmSync(info.path, { recursive: true, force: true });

  mutateCatalog((catalog) => {
    catalog.matters = catalog.matters.filter((m) => m.id !== id);
    if (catalog.lastOpenedId === id) catalog.lastOpenedId = null;
  });
}

function initSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      guid TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      extension TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      date_modified TEXT,
      date_created TEXT,
      title TEXT,
      author TEXT,
      subject TEXT,
      extra_json TEXT,
      imported_at TEXT NOT NULL
    )
  `);

  migrateFamilyColumns(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      is_custom INTEGER NOT NULL DEFAULT 0
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS document_tags (
      document_guid TEXT NOT NULL REFERENCES documents(guid) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (document_guid, tag_id)
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )
  `);

  // Full-text index, maintained manually alongside `documents` (insert on
  // import, delete on document delete) rather than via FTS5 external-content
  // triggers — simpler, and plenty fast at single-matter scale.
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      guid UNINDEXED,
      title,
      author,
      body
    )
  `);

  // RAG chunk embeddings — populated once at import time (the "index once"
  // cost), queried by brute-force cosine similarity at ask time. Plain
  // table + BLOB rather than a vector-search extension: simplest thing that
  // works at single-matter scale, no extra native dependency.
  database.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      guid TEXT NOT NULL REFERENCES documents(guid) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      PRIMARY KEY (guid, chunk_index)
    )
  `);

  // RAG embedding is deliberately NOT done inline during import — a slow or
  // busy Ollama stalled real imports for 30+ seconds in testing. Documents
  // land here at commit time and a background loop (embeddingWorker.ts)
  // drains it independently, so ingest throughput never depends on LLM
  // latency.
  database.exec(`
    CREATE TABLE IF NOT EXISTS embedding_queue (
      guid TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      enqueued_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    )
  `);

  seedTags(database);
}

// `documents` predates the family/attachment feature — add the new columns
// to any matter database created before this migration existed, so opening
// an older matter upgrades it in place instead of erroring on first import.
function migrateFamilyColumns(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));
  if (!names.has("family_id")) database.exec("ALTER TABLE documents ADD COLUMN family_id TEXT");
  if (!names.has("parent_guid")) database.exec("ALTER TABLE documents ADD COLUMN parent_guid TEXT");
  if (!names.has("depth")) database.exec("ALTER TABLE documents ADD COLUMN depth INTEGER NOT NULL DEFAULT 0");
  if (!names.has("to_addresses")) database.exec("ALTER TABLE documents ADD COLUMN to_addresses TEXT");
  if (!names.has("cc_addresses")) database.exec("ALTER TABLE documents ADD COLUMN cc_addresses TEXT");
}

export function indexDocumentText(guid: string, title: string | null, author: string | null, body: string | null): void {
  const database = getDb();
  database.prepare("DELETE FROM documents_fts WHERE guid = ?").run(guid);
  database
    .prepare("INSERT INTO documents_fts (guid, title, author, body) VALUES (?, ?, ?, ?)")
    .run(guid, title ?? "", author ?? "", body ?? "");
}

export function removeDocumentText(guid: string): void {
  getDb().prepare("DELETE FROM documents_fts WHERE guid = ?").run(guid);
}

export interface StoredChunk {
  guid: string;
  chunkIndex: number;
  text: string;
  embedding: Float32Array;
}

function toBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function fromBlob(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

export function saveChunks(guid: string, chunks: Array<{ index: number; text: string; embedding: Float32Array }>): void {
  const database = getDb();
  database.prepare("DELETE FROM chunks WHERE guid = ?").run(guid);
  const insert = database.prepare("INSERT INTO chunks (guid, chunk_index, text, embedding) VALUES (?, ?, ?, ?)");
  for (const c of chunks) insert.run(guid, c.index, c.text, toBlob(c.embedding));
}

export function removeChunks(guid: string): void {
  getDb().prepare("DELETE FROM chunks WHERE guid = ?").run(guid);
}

export function getAllChunks(): StoredChunk[] {
  const rows = getDb().prepare("SELECT guid, chunk_index, text, embedding FROM chunks").all() as Array<{
    guid: string;
    chunk_index: number;
    text: string;
    embedding: Uint8Array;
  }>;
  return rows.map((r) => ({ guid: r.guid, chunkIndex: r.chunk_index, text: r.text, embedding: fromBlob(r.embedding) }));
}

const MAX_EMBEDDING_ATTEMPTS = 3;

export function enqueueEmbedding(guid: string, text: string): void {
  if (!text.trim()) return;
  getDb()
    .prepare(
      `INSERT INTO embedding_queue (guid, text, enqueued_at, attempts) VALUES (?, ?, ?, 0)
       ON CONFLICT(guid) DO UPDATE SET text = excluded.text, attempts = 0`,
    )
    .run(guid, text, new Date().toISOString());
}

export function dequeueEmbeddingBatch(limit: number): Array<{ guid: string; text: string }> {
  return getDb()
    .prepare("SELECT guid, text FROM embedding_queue WHERE attempts < ? ORDER BY enqueued_at ASC LIMIT ?")
    .all(MAX_EMBEDDING_ATTEMPTS, limit) as Array<{ guid: string; text: string }>;
}

export function removeFromEmbeddingQueue(guid: string): void {
  getDb().prepare("DELETE FROM embedding_queue WHERE guid = ?").run(guid);
}

export function bumpEmbeddingAttempts(guid: string): void {
  getDb().prepare("UPDATE embedding_queue SET attempts = attempts + 1 WHERE guid = ?").run(guid);
}

export function embeddingQueueDepth(): number {
  const row = getDb().prepare("SELECT COUNT(*) as c FROM embedding_queue").get() as { c: number };
  return row.c;
}

// FTS5 MATCH throws on malformed boolean/phrase syntax — fall back to
// treating the whole query as a literal phrase so a stray query never 500s.
export function searchDocumentGuids(query: string): Set<string> {
  const database = getDb();
  try {
    const rows = database.prepare("SELECT guid FROM documents_fts WHERE documents_fts MATCH ?").all(query) as Array<{
      guid: string;
    }>;
    return new Set(rows.map((r) => r.guid));
  } catch {
    try {
      const phrase = `"${query.replace(/"/g, '""')}"`;
      const rows = database.prepare("SELECT guid FROM documents_fts WHERE documents_fts MATCH ?").all(phrase) as Array<{
        guid: string;
      }>;
      return new Set(rows.map((r) => r.guid));
    } catch {
      return new Set();
    }
  }
}

const STANDARD_TAGS: Array<{ name: string; color: string }> = [
  { name: "Privileged", color: "#A6362C" },
  { name: "Confidential", color: "#B4780C" },
  { name: "Relevant", color: "#1F6F3F" },
  { name: "Not Relevant", color: "#5B6272" },
  { name: "Hot Document", color: "#C22A6B" },
  { name: "Duplicate", color: "#5B6272" },
  { name: "Needs Review", color: "#2E6FA8" },
];

function seedTags(database: DatabaseSync) {
  const existing = database.prepare("SELECT COUNT(*) as c FROM tags").get() as { c: number };
  if (existing.c > 0) return;
  const insert = database.prepare("INSERT INTO tags (name, color, is_custom) VALUES (?, ?, 0)");
  for (const t of STANDARD_TAGS) insert.run(t.name, t.color);
}

export function nextGuid(): string {
  const database = getDb();
  database.prepare("INSERT INTO counters (name, value) VALUES ('document_guid', 0) ON CONFLICT(name) DO NOTHING").run();
  database.prepare("UPDATE counters SET value = value + 1 WHERE name = 'document_guid'").run();
  const row = database.prepare("SELECT value FROM counters WHERE name = 'document_guid'").get() as { value: number };
  return String(row.value).padStart(6, "0");
}

// Auto-reopen the last-used matter on server start, so a restart doesn't
// strand the user on the matter picker unnecessarily.
const lastId = getLastOpenedMatterId();
if (lastId && readCatalog().matters.some((m) => m.id === lastId)) {
  try {
    openMatter(lastId);
  } catch (err) {
    console.warn(`Failed to reopen last matter (${lastId}):`, (err as Error).message);
  }
}

export interface DocumentRow {
  guid: string;
  original_name: string;
  extension: string;
  stored_path: string;
  size_bytes: number;
  date_modified: string | null;
  date_created: string | null;
  title: string | null;
  author: string | null;
  subject: string | null;
  extra_json: string | null;
  imported_at: string;
  family_id: string | null;
  parent_guid: string | null;
  depth: number;
  to_addresses: string | null;
  cc_addresses: string | null;
}

export interface TagRow {
  id: number;
  name: string;
  color: string;
  is_custom: number;
}
