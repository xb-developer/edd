import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api";
import type { WorkerStatusDTO } from "./types";

export interface WorkerHealthBarProps {
  api: ApiClient;
}

const POLL_INTERVAL_MS = 4000;
// A tick older than this is treated as "stalled," not just "idle" — the
// worker's own long-poll (WaitTimeSeconds: 20 in queues.ts) means a healthy,
// message-free queue still ticks at least every ~20s.
const STALE_TICK_MS = 30_000;

function secondsAgo(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 1000);
}

/**
 * Admin-only live worker status in the topbar (see EddWorkbenchWorkspace.tsx) —
 * the Processing Status panel's "worker health bar" from the POC, ported as
 * a persistent indicator rather than a togglable panel, since it's cheap
 * enough to just always show for an admin. Polls GET /api/worker-status
 * (403s for non-admins, so this component is only ever mounted for one).
 */
export function WorkerHealthBar({ api }: WorkerHealthBarProps) {
  const [status, setStatus] = useState<WorkerStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  if (error) return <span className="worker-health-bar muted">Worker status unavailable</span>;
  if (!status) return null;

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
    </span>
  );
}
