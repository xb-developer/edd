import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api";
import type { AiUsageDTO } from "./types";

export interface AiUsageBadgeProps {
  api: ApiClient;
}

// Token usage doesn't need live/real-time freshness the way worker health
// does — a slower poll than WorkerHealthBar's is plenty to reflect a
// question just asked.
const POLL_INTERVAL_MS = 15_000;

/**
 * Every user's own running AI token usage in the topbar (see
 * EddWorkbenchWorkspace.tsx) — GET /api/ai-usage/me, which is scoped to
 * the caller by req.eddContext server-side, so there's no per-user access
 * check needed here (WorkerHealthBar likewise needs no role gate).
 */
export function AiUsageBadge({ api }: AiUsageBadgeProps) {
  const [usage, setUsage] = useState<AiUsageDTO | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      try {
        const result = await api.getAiUsage();
        if (mountedRef.current) setUsage(result);
      } catch {
        // Best-effort display only — a failure here shouldn't show an
        // error state in the topbar, just skip updating this tick.
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

  if (!usage) return null;

  return (
    <span className="ai-usage-bar" title="Your AI token usage">
      <span className="ai-usage-chip">
        embedding: {usage.embedding} · ask: {usage.ask} · summarization: {usage.summarization} · <strong>total: {usage.total}</strong>
      </span>
    </span>
  );
}
