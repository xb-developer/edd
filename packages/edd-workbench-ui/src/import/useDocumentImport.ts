import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api";
import { runImport, type ImportFailure } from "./runImport";
import { stepIngestWatch, type IngestWatchStatusLookup } from "./ingestWatch";

export interface ImportProgress {
  current: number;
  total: number;
  errors: number;
}

export interface IngestProgress {
  total: number;
  remaining: number;
  failed: number;
  gaveUp: boolean;
}

export interface UseDocumentImportResult {
  importing: boolean;
  importProgress: ImportProgress | null;
  /** Backend ingest/processing phase — separate from `importProgress` (the S3 PUT step). Non-null from the moment a batch's uploads finish until every uploaded document has left pending/processing, or the poll gives up. */
  ingestProgress: IngestProgress | null;
  importFailures: ImportFailure[] | null;
  importFiles: (files: File[]) => Promise<void>;
  dismissFailures: () => void;
  dismissIngestProgress: () => void;
}

const INGEST_POLL_INTERVAL_MS = 3000;
// ~2 minutes — bounds the poll so a document whose upload-complete call
// itself failed, or whose SQS message dead-letters, can't spin the banner
// forever.
const MAX_INGEST_POLL_ATTEMPTS = 40;

/**
 * Thin React wrapper around `runImport` — this file owns the real
 * `fetch()`/`api` calls and the progress/failure state; `runImport.ts`
 * (unit-tested) owns the actual concurrency/failure-collection logic, and
 * `ingestWatch.ts` (also unit-tested) owns the pure "which ids are still
 * pending, should we give up" decision for the second (backend-processing)
 * phase added here. No automated test covers this file directly, same as
 * `useViewerWindow.ts` — this project has no React component-test harness
 * (no jsdom anywhere in the monorepo), and "does a real S3 presigned PUT
 * actually succeed from a browser, does the poll actually reach 100%
 * against the real worker" has no meaningful local substitute; see the
 * migration plan's manual-verification section.
 */
export function useDocumentImport(api: ApiClient, matterId: string, onFileSettled?: () => void): UseDocumentImportResult {
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importFailures, setImportFailures] = useState<ImportFailure[] | null>(null);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);

  // Ids currently being watched (union across every batch started since the
  // last time ingestProgress went back to null) — a Set, not an array, so a
  // second import started while the first is still processing merges
  // cleanly instead of racing a replace.
  const watchedIdsRef = useRef<Set<string>>(new Set());
  // Denominator across the whole watch "session" (all batches since the
  // last reset) — stepIngestWatch only ever sees stillPending shrink, so
  // this has to be tracked separately to keep "N of M" stable as ids go
  // terminal one at a time.
  const totalWatchedRef = useRef(0);
  const attemptRef = useRef(0);
  // Read through a ref, not the dependency array — a fresh closure every
  // render would otherwise restart the interval on every render (the same
  // problem useViewerWindow.ts's stateRef avoids).
  const onFileSettledRef = useRef(onFileSettled);
  useEffect(() => {
    onFileSettledRef.current = onFileSettled;
  }, [onFileSettled]);

  useEffect(() => {
    const timer = setInterval(async () => {
      if (watchedIdsRef.current.size === 0) return;
      attemptRef.current++;

      let latest;
      try {
        latest = await api.getMatterDocuments(matterId);
      } catch {
        return; // Transient fetch failure — try again next tick, don't give up on a network blip.
      }

      const statusByDocumentId: IngestWatchStatusLookup = {};
      for (const doc of latest) statusByDocumentId[doc.documentId] = doc.ingestStatus;

      const result = stepIngestWatch(Array.from(watchedIdsRef.current), statusByDocumentId, attemptRef.current, MAX_INGEST_POLL_ATTEMPTS);
      watchedIdsRef.current = new Set(result.stillPending);

      setIngestProgress((prev) => {
        const failed = (prev?.failed ?? 0) + result.failedCount;
        // Auto-dismiss only on a clean finish (nothing left pending, no
        // failures) — same as the upload-phase banner clearing itself once
        // its batch finishes. A finish with failures, or a "gave up" state,
        // needs a human to notice it, so it stays until dismissIngestProgress.
        if (result.stillPending.length === 0 && failed === 0) {
          totalWatchedRef.current = 0;
          attemptRef.current = 0;
          return null;
        }
        return { total: totalWatchedRef.current, remaining: result.stillPending.length, failed, gaveUp: result.giveUp };
      });

      // This getMatterDocuments call above IS the refresh — no second
      // fetch needed. An extra network round trip once every 3s while
      // nothing has changed is a non-issue at eDiscovery matter volumes,
      // and reusing the same callback MatterDetail already passes in for
      // the upload phase avoids threading a second data path through.
      onFileSettledRef.current?.();
    }, INGEST_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [api, matterId]);

  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      setImporting(true);
      setImportFailures(null);
      setImportProgress({ current: 0, total: files.length, errors: 0 });

      const uploadedIds: string[] = [];

      const { failures } = await runImport(files, {
        initUpload: (batch) =>
          api.initUpload(
            matterId,
            batch.map((file) => ({
              filename: file.name,
              size: file.size,
              contentType: file.type || undefined,
              lastModified: file.lastModified,
            })),
          ),
        uploadOne: async (file, init) => {
          // Content-Type here must exactly match what was reported to
          // initUpload — it's baked into the presigned URL's SigV4
          // signature, and a mismatch (or an unexpectedly-added header on
          // an unsigned one) gets the PUT rejected by S3, not silently
          // ignored.
          const res = await fetch(init.uploadUrl, {
            method: "PUT",
            body: file,
            headers: file.type ? { "Content-Type": file.type } : {},
          });
          if (!res.ok) throw new Error(`Upload to storage failed (${res.status})`);
          await api.uploadComplete(matterId, init.documentId);
          // Only recorded once upload-complete has actually succeeded —
          // that's the point the SQS message really got sent, so it's the
          // first moment ingestStatus can ever move off "pending".
          uploadedIds.push(init.documentId);
        },
        onFileSettled: (_file, error) => {
          setImportProgress((prev) =>
            prev ? { current: prev.current + 1, total: prev.total, errors: prev.errors + (error ? 1 : 0) } : prev,
          );
          // Refreshing on every settle (not just successes) also covers the
          // partial-failure case where the upload itself succeeded but
          // upload-complete didn't — the document row still exists
          // (pending forever without this), so the list should still
          // reflect it even though this file also counts as a failure.
          onFileSettledRef.current?.();
        },
      });

      setImporting(false);
      setImportProgress(null);
      if (failures.length > 0) setImportFailures(failures);

      if (uploadedIds.length > 0) {
        for (const id of uploadedIds) watchedIdsRef.current.add(id);
        totalWatchedRef.current += uploadedIds.length;
        attemptRef.current = 0;
        setIngestProgress((prev) => ({
          total: totalWatchedRef.current,
          remaining: watchedIdsRef.current.size,
          failed: prev?.failed ?? 0,
          gaveUp: false,
        }));
      }
    },
    [api, matterId],
  );

  const dismissFailures = useCallback(() => setImportFailures(null), []);

  const dismissIngestProgress = useCallback(() => {
    watchedIdsRef.current = new Set();
    totalWatchedRef.current = 0;
    attemptRef.current = 0;
    setIngestProgress(null);
  }, []);

  return { importing, importProgress, ingestProgress, importFailures, importFiles, dismissFailures, dismissIngestProgress };
}
