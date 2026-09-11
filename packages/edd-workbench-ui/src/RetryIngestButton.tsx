import { useState } from "react";
import { Alert, Button } from "antd";
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
      {/* `loading` replaces the old "Retrying…" label swap: antd shows a
          spinner and disables the button itself, so in-flight state can't
          drift out of step with the disabled state. */}
      <Button
        block
        size="small"
        className="mb-1.5 justify-start"
        icon={<span aria-hidden>↻</span>}
        disabled={documentIds.length === 0}
        loading={inFlight}
        onClick={handleRetry}
      >
        Retry ingest
      </Button>
      {error && <Alert type="error" showIcon className="mt-1.5" message={`Retry failed: ${error}`} />}
    </>
  );
}
