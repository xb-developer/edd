import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api";
import { runImport, type ImportFailure } from "./runImport";
import { stepIngestWatch } from "./ingestWatch";

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
  /** Fires once a batch settles (cleanly or via give-up) — see onFileSettled's own doc comment on why this is the ONLY point `onFileSettled` (MatterDetail's refreshDocuments) is invoked from now. */
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

  // upload_batch_id(s) currently being watched (union across every batch
  // started since the last time ingestProgress went back to null) — a Set,
  // not a single id, so a second import started while the first is still
  // processing merges cleanly instead of racing a replace. A whole batch id
  // (not individual document ids) is what's tracked now — see migration
  // 034 — so a container's exploded children (created well after the
  // container's own upload, with ids the client never sees) are counted
  // automatically, with no need to know their ids in advance.
  const activeBatchIdsRef = useRef<Set<string>>(new Set());
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
      if (activeBatchIdsRef.current.size === 0) return;
      attemptRef.current++;

      let latest;
      try {
        latest = await api.getMatterDocuments(matterId);
      } catch {
        return; // Transient fetch failure — try again next tick, don't give up on a network blip.
      }

      const result = stepIngestWatch(latest, activeBatchIdsRef.current, attemptRef.current, MAX_INGEST_POLL_ATTEMPTS);
      const settled = result.pendingCount === 0 || result.giveUp;

      setIngestProgress(() => {
        if (settled && result.failedCount === 0) return null;
        return {
          total: result.pendingCount + result.readyCount + result.failedCount,
          remaining: result.pendingCount,
          failed: result.failedCount,
          gaveUp: result.giveUp,
        };
      });

      // Deliberately NOT called on every tick (unlike the old per-document
      // watch this replaced) — the whole point of batching by
      // upload_batch_id is that the document list only updates once the
      // WHOLE batch has left pending/processing (or the poll gives up on
      // it), not incrementally as individual documents finish. See
      // ingestWatch.ts's own comment for why a container's own row
      // disappearing needs no special handling here any more.
      if (settled) {
        activeBatchIdsRef.current = new Set();
        attemptRef.current = 0;
        onFileSettledRef.current?.();
      }
    }, INGEST_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [api, matterId]);

  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      // One id for every file picked in this call — set at init-upload
      // time and inherited by every descendant a container later expands
      // into (see migration 034), so the whole tree this upload eventually
      // produces is watched as one unit, not just the top-level files.
      const uploadBatchId = crypto.randomUUID();
      let anyUploaded = false;

      setImporting(true);
      setImportFailures(null);
      setImportProgress({ current: 0, total: files.length, errors: 0 });

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
            uploadBatchId,
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
          anyUploaded = true;
        },
        onFileSettled: (_file, error) => {
          setImportProgress((prev) =>
            prev ? { current: prev.current + 1, total: prev.total, errors: prev.errors + (error ? 1 : 0) } : prev,
          );
          // Deliberately does NOT call onFileSettledRef here any more — the
          // document list is deferred until the whole batch (this upload
          // phase AND the backend ingest that follows) settles, handled by
          // the poll effect above. A document whose own upload-complete
          // call fails never joins a watched batch (see the ingest-watch
          // effect's `pendingCount` — a row with no successful
          // upload-complete never got enqueued, so it'd never leave
          // "pending" on its own); it still surfaces, just later, once the
          // batch's poll gives up after MAX_INGEST_POLL_ATTEMPTS and
          // refreshes anyway.
        },
      });

      setImporting(false);
      setImportProgress(null);
      if (failures.length > 0) setImportFailures(failures);

      if (anyUploaded) {
        activeBatchIdsRef.current.add(uploadBatchId);
        attemptRef.current = 0;
        setIngestProgress((prev) => ({
          total: prev?.total ?? files.length,
          remaining: prev?.remaining ?? files.length,
          failed: prev?.failed ?? 0,
          gaveUp: false,
        }));
      }
    },
    [api, matterId],
  );

  const dismissFailures = useCallback(() => setImportFailures(null), []);

  const dismissIngestProgress = useCallback(() => {
    activeBatchIdsRef.current = new Set();
    attemptRef.current = 0;
    setIngestProgress(null);
  }, []);

  return { importing, importProgress, ingestProgress, importFailures, importFiles, dismissFailures, dismissIngestProgress };
}
