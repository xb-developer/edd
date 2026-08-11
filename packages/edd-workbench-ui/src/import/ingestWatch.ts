/** documentId -> ingestStatus, from the latest getMatterDocuments refetch. An id absent from this lookup (not yet visible in a response, or deleted mid-poll) is treated as "unknown", not terminal. */
export interface IngestWatchStatusLookup {
  [documentId: string]: "pending" | "processing" | "ready" | "failed" | undefined;
}

export interface IngestWatchStepResult {
  stillPending: string[];
  readyCount: number;
  failedCount: number;
  /** True once `attempt >= maxAttempts` and stillPending is non-empty — the caller should stop polling and show a "give up" state rather than loop forever (a document whose upload-complete call itself failed, or whose SQS message dead-letters, would otherwise spin the banner indefinitely). */
  giveUp: boolean;
}

/**
 * One pure step of the ingest-watch loop: given the set of documentIds
 * still being watched and the latest known ingestStatus per document,
 * decides which ids have left pending/processing and whether to keep
 * polling. No timers, no fetch — the effectful shell (useDocumentImport.ts)
 * owns setInterval and the actual refetch, same pure/effectful split as
 * runImport.ts/popoutState.ts.
 */
export function stepIngestWatch(
  watchedIds: readonly string[],
  statusByDocumentId: IngestWatchStatusLookup,
  attempt: number,
  maxAttempts: number,
): IngestWatchStepResult {
  let readyCount = 0;
  let failedCount = 0;
  const stillPending: string[] = [];

  for (const id of watchedIds) {
    const status = statusByDocumentId[id];
    if (status === "ready") readyCount++;
    else if (status === "failed") failedCount++;
    else stillPending.push(id);
  }

  return {
    stillPending,
    readyCount,
    failedCount,
    giveUp: stillPending.length > 0 && attempt >= maxAttempts,
  };
}
