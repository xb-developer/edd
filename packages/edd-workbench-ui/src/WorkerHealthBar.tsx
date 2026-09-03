import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api";
import type { WorkerStatusDTO, SearchHealthDTO } from "./types";

export interface WorkerHealthBarProps {
  api: ApiClient;
}

const POLL_INTERVAL_MS = 4000;
// A tick older than this is treated as "stalled," not just "idle" — the
// worker's own long-poll (WaitTimeSeconds: 20 in queues.ts) means a healthy,
// message-free queue still ticks at least every ~20s.
const STALE_TICK_MS = 30_000;
// Search-index health doesn't need live/real-time freshness the way queue
// status does — a slower poll is plenty.
const SEARCH_HEALTH_POLL_INTERVAL_MS = 60_000;
// A handful of documents behind is normal (async indexing via SQS —
// something mid-flight through the pipeline), not a real problem. Only
// flag a gap large enough to actually mean "the index is missing real
// data" (e.g. after a lost Elasticsearch instance with no snapshot yet).
const SEARCH_HEALTH_MISMATCH_THRESHOLD = 5;

function secondsAgo(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 1000);
}

/**
 * Live worker status in the topbar (see EddWorkbenchWorkspace.tsx) — the
 * Processing Status panel's "worker health bar" from the POC, ported as a
 * persistent indicator rather than a togglable panel, since it's cheap
 * enough to just always show. Polls GET /api/worker-status, available to
 * any authenticated caller.
 */
export function WorkerHealthBar({ api }: WorkerHealthBarProps) {
  const [status, setStatus] = useState<WorkerStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchHealth, setSearchHealth] = useState<SearchHealthDTO | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      try {
        const result = await api.getWorkerStatus();
        if (mountedRef.current) {
          setStatus(result);
          setError(null);
        }
      } catch (err) {
        if (mountedRef.current) setError((err as Error).message);
      } finally {
        if (mountedRef.current) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    tick();

    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
    };
  }, [api]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    async function tick() {
      try {
        const result = await api.getSearchHealth();
        if (!cancelled) setSearchHealth(result);
      } catch {
        // Best-effort display only, same as the search UI's own fallback —
        // just skip updating this tick rather than showing an error chip.
      } finally {
        if (!cancelled) timer = setTimeout(tick, SEARCH_HEALTH_POLL_INTERVAL_MS);
      }
    }
    tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api]);

  if (error) return <span className="worker-health-bar muted">Worker status unavailable</span>;
  if (!status) return null;

  const searchMismatch = searchHealth && searchHealth.postgresDocCount - searchHealth.esDocCount > SEARCH_HEALTH_MISMATCH_THRESHOLD;

  return (
    <span className="worker-health-bar">
      {status.queues.map((queue) => {
        const ageSeconds = secondsAgo(queue.heartbeat?.lastTickAt ?? null);
        const stalled = ageSeconds === null || ageSeconds * 1000 > STALE_TICK_MS;
        const working = queue.heartbeat?.processingStartedAt != null;
        return (
          <span key={queue.name} className={`worker-health-chip${stalled ? " stalled" : ""}`} title={queue.heartbeat?.queueName}>
            {queue.name}: {stalled ? "stalled" : working ? "working" : "idle"}
            {queue.approximateMessages !== null && ` · ${queue.approximateMessages} queued`}
            {queue.heartbeat && ` · ${queue.heartbeat.processedTotal} ok / ${queue.heartbeat.failedTotal} failed`}
          </span>
        );
      })}
      {searchHealth && (
        <span
          className={`worker-health-chip${searchMismatch ? " stalled" : ""}`}
          title="Elasticsearch document count vs. Postgres's own ready/failed document count — a small gap is normal async-indexing lag; a large one usually means reindexSearch.ts needs re-running."
        >
          search: {searchHealth.esDocCount}/{searchHealth.postgresDocCount} indexed
        </span>
      )}
    </span>
  );
}
