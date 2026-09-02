import { useState } from "react";
import type { ApiClient } from "./api";

export interface RetryIngestButtonProps {
  api: ApiClient;
  matterId: string;
  /** Already narrowed by the caller to checked ids whose ingestStatus is 'failed' — see FilterPanel's own computation. Sending a non-failed id 400s server-side, so the caller filtering first avoids a confusing rejection from an otherwise-valid broader selection. */
  documentIds: string[];
  /** Called after a successful retry so the caller can re-fetch the document list and show the fresh 'pending' status/cleared error immediately, rather than waiting for the next unrelated refresh. */
  onRetried: () => void;
}

/**
 * A single fire-and-refresh action, unlike ExportButtons' poll loop — retry
 * just resets status and re-enqueues (202), and this app has no live
 * document-list polling yet (MatterDetail only ever refetches after an
 * explicit action), so there's nothing to poll toward here. The eventual
 * 'ready'/'failed' outcome shows up next time something else triggers a
 * refresh, same as a normal upload's already-async ingest today.
 */
export function RetryIngestButton({ api, matterId, documentIds, onRetried }: RetryIngestButtonProps) {
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRetry() {
    setInFlight(true);
    setError(null);
    try {
      await api.retryIngest(matterId, documentIds);
      onRetried();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInFlight(false);
    }
  }

  return (
    <>
      <button type="button" className="export-btn" disabled={documentIds.length === 0 || inFlight} onClick={handleRetry}>
        <span className="ico">↻</span> {inFlight ? "Retrying…" : "Retry ingest"}
      </button>
      {error && <p className="preview-unsupported">Retry failed: {error}</p>}
    </>
  );
}
