/**
 * One document row's shape, as far as this pure module cares — a subset of
 * DocumentDTO so tests can pass plain objects without importing the real
 * type.
 */
export interface IngestWatchDocument {
  uploadBatchId: string;
  ingestStatus: "pending" | "processing" | "ready" | "failed";
}

export interface IngestWatchStepResult {
  /** Count of documents currently tagged with one of the watched batch ids that are still pending/processing. */
  pendingCount: number;
  readyCount: number;
  failedCount: number;
  /** True once `attempt >= maxAttempts` and pendingCount is non-zero — the caller should stop polling and show a "give up" state rather than loop forever (a document whose upload-complete call itself failed, or whose SQS message dead-letters, would otherwise spin the banner indefinitely). */
  giveUp: boolean;
}

/**
 * One pure step of the ingest-watch loop: given every document currently
 * tagged with one of the watched upload_batch_ids (see migration 034) and
 * the current polling attempt, summarizes how much of the batch is left.
 *
 * Unlike the old per-document-id watch this replaces, there's no need to
 * special-case a row that's since been deleted (a fully successful
 * transparent-container expansion — pst/zip/7z/mbox — deletes its own
 * container row once every member has been extracted): a deleted row
 * simply isn't in `documents` any more, so it silently stops contributing
 * to any of the three counts below, which is exactly correct — it's gone
 * because its work is done, and every one of its extracted children (which
 * inherited the same upload_batch_id) is still counted individually until
 * *they* resolve too. No timers, no fetch — the effectful shell
 * (useDocumentImport.ts) owns setInterval and the actual refetch, same
 * pure/effectful split as runImport.ts/popoutState.ts.
 */
export function stepIngestWatch(
  documents: readonly IngestWatchDocument[],
  watchedBatchIds: ReadonlySet<string>,
  attempt: number,
  maxAttempts: number,
): IngestWatchStepResult {
  let pendingCount = 0;
  let readyCount = 0;
  let failedCount = 0;

  for (const doc of documents) {
    if (!watchedBatchIds.has(doc.uploadBatchId)) continue;
    if (doc.ingestStatus === "failed") failedCount++;
    else if (doc.ingestStatus === "ready") readyCount++;
    else pendingCount++;
  }

  return {
    pendingCount,
    readyCount,
    failedCount,
    giveUp: pendingCount > 0 && attempt >= maxAttempts,
  };
}
