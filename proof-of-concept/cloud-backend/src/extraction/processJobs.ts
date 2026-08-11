import { withTenantContext } from "../db/pool.js";
import { getDocumentStore } from "../storage/index.js";
import { extractText } from "./extract.js";
import { embedDocument } from "../rag/embedDocument.js";

const worker = { organizationId: null, userId: null, isPlatformAdmin: true } as const;

interface ClaimedJob {
  jobId: number;
  type: string;
  documentId: string;
}

/**
 * Claims and processes at most one pending job (extract or embed). Returns
 * true if a job was found (whether it succeeded or failed), false if the
 * queue was empty — the caller (src/worker.ts) loops on this; tests call it
 * directly to process exactly one job deterministically.
 *
 * Known Phase 2 gap, not addressed here: a job that crashes the worker
 * mid-processing (after being claimed, before the final UPDATE) is left in
 * 'processing' forever with no reaper to requeue it. Fine for a dev-scale
 * pilot; production needs a stale-job sweep before real volume.
 */
export async function runOnce(): Promise<boolean> {
  const claimed = await claimNextJob();
  if (!claimed) return false;

  try {
    if (claimed.type === "extract") {
      await processExtractJob(claimed);
    } else if (claimed.type === "embed") {
      await processEmbedJob(claimed);
    } else {
      throw new Error(`unknown job type: ${claimed.type}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTenantContext(worker, async (client) => {
      if (claimed.type === "extract") {
        await client.query("UPDATE documents SET status = 'extraction_failed', extraction_error = $2 WHERE id = $1", [
          claimed.documentId,
          message,
        ]);
      }
      await client.query(
        "UPDATE jobs SET status = 'failed', attempts = attempts + 1, last_error = $2, updated_at = now() WHERE id = $1",
        [claimed.jobId, message],
      );
    });
  }
  return true;
}

async function processExtractJob(claimed: ClaimedJob): Promise<void> {
  const doc = await withTenantContext(worker, async (client) => {
    const { rows } = await client.query("SELECT storage_key, filename FROM documents WHERE id = $1", [
      claimed.documentId,
    ]);
    return rows[0] as { storage_key: string; filename: string } | undefined;
  });
  if (!doc) throw new Error(`document ${claimed.documentId} not found`);

  const data = await getDocumentStore().get(doc.storage_key);
  const text = await extractText(data, doc.filename);

  await withTenantContext(worker, async (client) => {
    await client.query("UPDATE documents SET status = 'extracted', extracted_text = $2 WHERE id = $1", [
      claimed.documentId,
      text,
    ]);
    await client.query("UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1", [claimed.jobId]);
    // Embedding is deliberately its own queued job, not inline here — Section
    // 3.4 describes it as asynchronous/queue-driven, decoupled from extraction
    // latency so a slow embed doesn't hold up the extraction worker's throughput.
    await client.query("INSERT INTO jobs (type, document_id) VALUES ('embed', $1)", [claimed.documentId]);
  });
}

async function processEmbedJob(claimed: ClaimedJob): Promise<void> {
  await embedDocument(worker, claimed.documentId);
  await withTenantContext(worker, async (client) => {
    await client.query("UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1", [claimed.jobId]);
  });
}

async function claimNextJob(): Promise<ClaimedJob | null> {
  return withTenantContext(worker, async (client) => {
    const { rows } = await client.query(
      `UPDATE jobs SET status = 'processing', updated_at = now()
       WHERE id = (
         SELECT id FROM jobs WHERE status = 'pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, type, document_id`,
    );
    if (rows.length === 0) return null;
    return { jobId: rows[0].id, type: rows[0].type, documentId: rows[0].document_id };
  });
}
