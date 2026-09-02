/**
 * documentId -> ingestStatus, from the latest getMatterDocuments refetch.
 * An id absent from this lookup means its row was DELETED — a real,
 * expected outcome, not "hasn't loaded yet": a fully, successfully
 * expanded transparent container (PST/OST/zip/7z/mbox — see ingest.ts's
 * handlePstIngest et al.) deletes its own document row once every one of
 * its members/messages has been extracted, precisely because there's
 * nothing left to review beyond what's now its own independent children.
 * Every id this watcher ever tracks was already confirmed to exist (added
 * only after its own upload-complete call succeeded), so "absent" can only
 * mean that clean-deletion outcome, never "not yet visible" — treating it
 * as still-pending (the original design here) meant a fully successful
 * container upload could never be observed leaving pending at all, since
 * there's no "ready" row left to report one: the progress bar would sit
 * frozen until the poll simply gave up. Confirmed as a real bug on a real
 * PST upload, not a hypothetical.
 */
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
    if (status === "failed") failedCount++;
    // status === undefined: the row is gone — a fully successful
    // transparent-container expansion (see this file's own top comment),
    // counted as ready alongside a real "ready" row.
    else if (status === "ready" || status === undefined) readyCount++;
    else stillPending.push(id);
  }

  return {
    stillPending,
    readyCount,
    failedCount,
    giveUp: stillPending.length > 0 && attempt >= maxAttempts,
  };
}
