import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const dataDir = path.join(homedir(), "AppData", "Roaming", "XBundle Assemble");
mkdirSync(dataDir, { recursive: true });

// Node's built-in SQLite — no native compilation needed (better-sqlite3
// requires node-gyp + Visual Studio Build Tools, not installed on this
// machine; see memory feedback_windows_node_env / project_xbview_alpha_build).
export const db = new DatabaseSync(path.join(dataDir, "assemble.sqlite"));

// Plain rollback-journal mode (SQLite's own default), deliberately NOT WAL.
// WAL mode keeps the most recent writes in a separate, ever-growing
// .sqlite-wal sidecar file until a checkpoint merges them into the main
// file — a checkpoint that never runs on a forceful process kill. A
// duplicate dev-server instance getting force-killed took the real
// assembly data down with it exactly this way once already. Rollback-
// journal mode has no such gap: every committed transaction is durable in
// the single .sqlite file by the time the call returns, regardless of how
// the process later dies. This app has no legitimate concurrent-writer
// scenario (only ever one server process talking to this file by design),
// so WAL's main benefit — concurrent readers during a writer — isn't
// needed here, and isn't worth this durability trade-off.
db.exec("PRAGMA journal_mode = DELETE");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS bundles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    display_order INTEGER NOT NULL
  )
`);

// `title` is the bundle's full free-text display name (e.g. "Hearing Bundle
// CCMC before Judge Grocer"). `label` is the short citation prefix used in
// page references ("A-2") and /PageLabels — a genuinely separate concept,
// split out after a real bug: the two were originally the same field, so
// renaming a bundle to a full descriptive name leaked straight into every
// document's "(page ...)" bookmark suffix. Migration is idempotent (a
// duplicate-column error just means it already ran on this database) so
// existing bundles/data are preserved, not recreated.
try {
  db.exec("ALTER TABLE bundles ADD COLUMN label TEXT NOT NULL DEFAULT ''");
} catch {
  // column already exists
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tabs (
    id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    display_order INTEGER NOT NULL
  )
`);

// A tab can itself be nested inside another tab (to any depth) — null means
// "top-level, directly under the bundle". ON DELETE CASCADE means deleting a
// tab automatically removes every descendant sub-tab too; each of those
// sub-tabs' own documents still fall back to staging on their own accord via
// documents.tab_id's existing ON DELETE SET NULL, so the whole cascade needs
// no extra application-level cleanup — same idempotent migration pattern as
// the `bundles.label` column above.
try {
  db.exec("ALTER TABLE tabs ADD COLUMN parent_tab_id TEXT REFERENCES tabs(id) ON DELETE CASCADE");
} catch {
  // column already exists
}

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    date TEXT,
    source_path TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    tab_id TEXT REFERENCES tabs(id) ON DELETE SET NULL,
    display_order INTEGER NOT NULL,
    added_at TEXT NOT NULL
  )
`);

// Single-row table (id fixed at 1) — one case heading applies to the whole
// assembly, shown on every bundle's first Index page, matching how a real
// multi-bundle case (e.g. Bundles A/B/B2/C) shares one case heading across
// all of them. List-shaped fields (preamble/court lines/parties) are stored
// newline-separated and split at the API boundary.
db.exec(`
  CREATE TABLE IF NOT EXISTS case_heading (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    claim_no_label TEXT NOT NULL DEFAULT '',
    preamble TEXT NOT NULL DEFAULT '',
    court_lines TEXT NOT NULL DEFAULT '',
    claimants TEXT NOT NULL DEFAULT '',
    claimants_label TEXT NOT NULL DEFAULT 'Claimant',
    v_label TEXT NOT NULL DEFAULT '-v-',
    defendants TEXT NOT NULL DEFAULT '',
    defendants_label TEXT NOT NULL DEFAULT 'Defendant'
  )
`);

export interface CaseHeadingRow {
  id: 1;
  claim_no_label: string;
  preamble: string;
  court_lines: string;
  claimants: string;
  claimants_label: string;
  v_label: string;
  defendants: string;
  defendants_label: string;
}

export interface BundleRow {
  id: string;
  title: string;
  label: string;
  display_order: number;
}

export interface TabRow {
  id: string;
  bundle_id: string;
  title: string;
  display_order: number;
  parent_tab_id: string | null;
}

export interface DocumentRow {
  id: string;
  title: string;
  date: string | null;
  source_path: string;
  page_count: number;
  tab_id: string | null;
  display_order: number;
  added_at: string;
}
