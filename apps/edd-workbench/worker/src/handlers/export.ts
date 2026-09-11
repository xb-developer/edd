import { PassThrough, type Readable } from "node:stream";
import type { PoolClient } from "pg";
import archiver from "archiver";
import { stringify } from "csv-stringify/sync";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { withOrgSession, s3Client, formatGuid, DOCUMENTS_BUCKET, MATTER_DOCUMENT_TREE_CTE } from "@xbundle/edd-workbench-core";

interface ExportMessage {
  exportId: string;
  orgId: string;
}

interface ExportJobRow {
  id: string;
  matter_id: string;
  kind: string;
  document_ids: string[];
}

interface DocumentForZipRow {
  guid_number: number;
  extension: string;
  s3_key: string | null;
}

interface DocumentForCsvRow {
  guid_number: number;
  family_guid_number: number | null;
  original_filename: string;
  content_type_detected: string;
  size_bytes: string;
  // node-pg parses both `date` and `timestamptz` columns into real JS Date
  // instances, not strings — formatDateCell below is what actually renders
  // them; csv-stringify's own default Date cast calls getTime(), which
  // would otherwise silently put a raw epoch-millisecond number in these
  // cells instead of a readable date.
  doc_date: Date | null;
  file_modified_at: Date | null;
  author: string | null;
  metadata: { to?: string; cc?: string } | null;
  tags: string;
}

function formatDateCell(value: Date | null): string {
  return value ? value.toISOString() : "";
}

/**
 * Streams each selected document's real S3 object straight into an
 * `archiver` zip entry (never buffers a whole document in worker memory)
 * and uploads the archive stream to S3 via `@aws-sdk/lib-storage`'s Upload
 * helper. Tolerates a document deleted between job creation and export time
 * — the query below only returns rows that still exist, and a PST-internal
 * message with no backing S3 object (null s3_key, see migration 017) is
 * skipped rather than attempted.
 *
 * Sequencing matters here: every entry must be appended, THEN
 * `archive.finalize()` called, THEN `upload.done()` awaited — the Upload's
 * stream never ends until finalize() runs, so awaiting upload.done() before
 * finalize() (or finalizing before any entries are appended) deadlocks.
 */
async function buildDocumentsZip(client: PoolClient, orgId: string, job: ExportJobRow): Promise<string> {
  // Entry names use each document's DISPLAYED guid (computed from its
  // current tree position, same as the UI shows — see documentTree.ts), not
  // the raw guid_number column, so a partial export names files exactly the
  // way a reviewer would recognize them on screen. This still requires
  // walking the WHOLE matter's tree (not just the exported subset) — a
  // document's displayed number can't be known in isolation.
  const docs = await client.query<DocumentForZipRow>(
    `${MATTER_DOCUMENT_TREE_CTE}
     SELECT n.display_guid_number AS guid_number, d.extension, d.s3_key
     FROM numbered n
     JOIN documents d ON d.id = n.id
     WHERE n.id = ANY($2::uuid[])
     ORDER BY n.sort_path`,
    [job.matter_id, job.document_ids],
  );

  const resultKey = `exports/${orgId}/${job.matter_id}/${job.id}/documents.zip`;
  const archive = archiver("zip", { zlib: { level: 9 } });
  // archiver's own stream is built on the userland `readable-stream`
  // package, not node:stream — lib-storage's Upload does a real
  // `instanceof Readable` check against node:stream's own class and rejects
  // anything that isn't a genuine native Readable. Piping into a native
  // PassThrough (and handing Upload that instead) bridges the two without
  // buffering — this is the actual object whose stream Upload consumes.
  const passthrough = new PassThrough();
  archive.on("error", (err) => passthrough.destroy(err));
  archive.pipe(passthrough);
  const upload = new Upload({
    client: s3Client,
    params: { Bucket: DOCUMENTS_BUCKET, Key: resultKey, Body: passthrough },
  });

  try {
    for (const doc of docs.rows) {
      if (!doc.s3_key) continue; // no backing original file — nothing to add
      const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: doc.s3_key }));
      archive.append(object.Body as Readable, { name: `${formatGuid(doc.guid_number)}.${doc.extension}` });
    }
    archive.finalize();
    await upload.done();
  } catch (err) {
    // A missing S3 object (or any other mid-build failure) must not leave a
    // dangling multipart upload behind — best-effort abort, then let the
    // real error propagate to the caller's try/catch, which marks the whole
    // job failed with it recorded. Also destroy the archive itself: if the
    // failure happened after some entries were already appended, the
    // archive is still piped into the passthrough with an in-flight
    // GetObject stream feeding it — nobody drains it once abort() above
    // gives up on the upload.
    archive.destroy();
    await upload.abort().catch(() => {});
    throw err;
  }

  return resultKey;
}

const CSV_COLUMNS = ["GUID", "Family GUID", "Filename", "Type", "Size", "Date", "Date Modified", "Author", "To", "CC", "Tags"];

/**
 * One SQL query joining document_tags/tags (comma-joined tag names) and a
 * self-join on family_document_id for the Family GUID — the family ROOT's
 * displayed guid, matching documents.ts's own DTO semantics (family root,
 * not direct parent — those coincide at depth 1, which is why a same-named
 * bug joining on parent_document_id here went unnoticed until this file's
 * queries were rewritten to share documentTree.ts's tree-order numbering
 * anyway). Stringified via csv-stringify and uploaded as a plain
 * PutObjectCommand (small enough to hold in memory as a string, unlike the
 * zip path).
 */
async function buildPropertiesCsv(client: PoolClient, orgId: string, job: ExportJobRow): Promise<string> {
  const rows = await client.query<DocumentForCsvRow>(
    `${MATTER_DOCUMENT_TREE_CTE}
     SELECT n.display_guid_number AS guid_number, f.display_guid_number AS family_guid_number,
            d.original_filename, d.content_type_detected,
            d.size_bytes, d.doc_date, d.file_modified_at, d.author, d.metadata,
            COALESCE(string_agg(t.name, ', ' ORDER BY t.name), '') AS tags
     FROM numbered n
     JOIN documents d ON d.id = n.id
     LEFT JOIN numbered f ON f.id = n.family_document_id
     LEFT JOIN document_tags dt ON dt.document_id = n.id
     LEFT JOIN tags t ON t.id = dt.tag_id
     WHERE n.id = ANY($2::uuid[])
     GROUP BY n.id, n.display_guid_number, f.display_guid_number, d.original_filename, d.content_type_detected,
              d.size_bytes, d.doc_date, d.file_modified_at, d.author, d.metadata, n.sort_path
     ORDER BY n.sort_path`,
    [job.matter_id, job.document_ids],
  );

  const records = rows.rows.map((row) => ({
    GUID: formatGuid(row.guid_number),
    "Family GUID": formatGuid(row.family_guid_number ?? row.guid_number),
    Filename: row.original_filename,
    Type: row.content_type_detected,
    Size: row.size_bytes,
    Date: formatDateCell(row.doc_date),
    "Date Modified": formatDateCell(row.file_modified_at),
    Author: row.author ?? "",
    To: row.metadata?.to ?? "",
    CC: row.metadata?.cc ?? "",
    Tags: row.tags,
  }));

  const csv = stringify(records, { header: true, columns: CSV_COLUMNS });
  const resultKey = `exports/${orgId}/${job.matter_id}/${job.id}/properties.csv`;
  await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: resultKey, Body: csv }));

  return resultKey;
}

/**
 * Looks up the matter_exports row, marks it processing, builds the real
 * artifact (zip or CSV), and marks it ready with the resulting S3 key —
 * mirroring ingest.ts's try/catch -> status='failed', error=... idiom on
 * any thrown error, including one from an object genuinely missing in S3
 * (see buildDocumentsZip's GetObjectCommand call, which is not itself
 * wrapped — a document whose S3 object was removed independently of its DB
 * row fails the whole job with a recorded error, not silently, unlike a
 * document row that's simply gone, which buildDocumentsZip already
 * tolerates by omission from its own query).
 */
export async function handleExportMessage(body: string): Promise<void> {
  const { exportId, orgId } = JSON.parse(body) as ExportMessage;

  await withOrgSession(orgId, async (client) => {
    const jobRow = await client.query<ExportJobRow>("SELECT id, matter_id, kind, document_ids FROM matter_exports WHERE id = $1", [
      exportId,
    ]);
    if (jobRow.rowCount === 0) {
      // Job row is gone — nothing to do, not an error.
      return;
    }
    const job = jobRow.rows[0];

    // Written for post-hoc/operator visibility (e.g. inspecting a stuck
    // row), not live client polling — the whole build below runs inside
    // this same withOrgSession call, so this UPDATE doesn't actually commit
    // until the transaction ends alongside the final ready/failed UPDATE. A
    // polling client only ever observes pending -> ready (or -> failed),
    // same as ingest.ts's own single-transaction-per-message idiom this
    // mirrors.
    await client.query("UPDATE matter_exports SET status = 'processing' WHERE id = $1", [exportId]);

    try {
      const resultKey = job.kind === "documents" ? await buildDocumentsZip(client, orgId, job) : await buildPropertiesCsv(client, orgId, job);
      await client.query("UPDATE matter_exports SET status = 'ready', result_s3_key = $1, completed_at = now() WHERE id = $2", [
        resultKey,
        exportId,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await client.query("UPDATE matter_exports SET status = 'failed', error = $1, completed_at = now() WHERE id = $2", [message, exportId]);
    }
  });
}
