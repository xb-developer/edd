import "./loadEnv.js";
import { Client } from "pg";
import { resolveConnectionString, resolveSslConfig } from "./dbConnection.js";
import { resolveEmbeddableText } from "./embeddableText.js";
import { formatGuid } from "./guidCounter.js";
import { indexDocument } from "./searchClient.js";

// Runs as the DB owner (see migrate.ts's own comment for why) — needs to
// read every document across every org in one query, which a plain
// app-role connection (RLS-scoped to a single org per session) can't do.
//
// One-off script, run manually: (1) to backfill every document ingested
// before the search feature shipped, since the indexing hooks only fire on
// future ingest/OCR events; (2) as the disaster-recovery path after a lost
// Elasticsearch instance or a snapshot restore — cheap to re-run since it
// only replays already-extracted `metadata` text, no re-OCR needed.
const connectionString = resolveConnectionString("MIGRATE_DATABASE_URL");

interface DocumentRow {
  id: string;
  org_id: string;
  matter_id: string;
  original_filename: string;
  extension: string;
  content_type_detected: string;
  metadata: Record<string, unknown> | null;
  guid_number: number;
}

// Keyset-paginated (id > lastId ORDER BY id LIMIT N), not one unbounded
// SELECT * FROM documents — `metadata` can hold a whole document's
// extracted text (email bodies, OCR output), so loading every row across
// every org in a single query has real memory cost that grows with the
// corpus, not a fixed one. A real run against ~9,400 documents OOM-killed
// this script's own Fargate task (512MiB) doing exactly that; this keeps
// peak memory bounded to one page regardless of total document count.
const PAGE_SIZE = 500;

async function run(): Promise<void> {
  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();

  let indexed = 0;
  let failed = 0;
  let total = 0;
  let lastId: string | null = null;

  for (;;) {
    const result = await client.query<DocumentRow>(
      `SELECT id, org_id, matter_id, original_filename, extension, content_type_detected, metadata, guid_number
       FROM documents
       WHERE $2::uuid IS NULL OR id > $2
       ORDER BY id LIMIT $1`,
      [PAGE_SIZE, lastId],
    );
    const rows: DocumentRow[] = result.rows;
    if (rows.length === 0) break;
    total += rows.length;
    console.log(`Reindexing page of ${rows.length} documents (${total} so far)...`);

    for (const row of rows) {
      try {
        await indexDocument({
          documentId: row.id,
          orgId: row.org_id,
          matterId: row.matter_id,
          filename: row.original_filename,
          extension: row.extension,
          guid: formatGuid(row.guid_number),
          body: resolveEmbeddableText(row.content_type_detected, row.metadata) ?? "",
        });
        indexed++;
      } catch (err) {
        failed++;
        console.error(`Failed to index document ${row.id}:`, err);
      }
    }

    lastId = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }

  console.log(`Reindex complete: ${indexed} indexed, ${failed} failed.`);
  await client.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
