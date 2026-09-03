import { withOrgSession } from "./session.js";

export type AiUsageCallSite = "embedding" | "ask" | "summarization";

/**
 * Adds `tokens` to (org, user, call_site)'s running total — an upsert
 * against one row per (org, user, call_site), not an INSERT per call,
 * since this is a live running counter, not an event log.
 *
 * Deliberately never throws into its caller: this is a monitoring
 * side-effect, not part of the actual embedding/generation result, so a
 * transient DB hiccup here shouldn't turn an otherwise-successful
 * question/ingest into a 500 or a failed embedding_status.
 */
export async function recordAiUsage(orgId: string, userId: string, callSite: AiUsageCallSite, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  try {
    await withOrgSession(orgId, (client) =>
      client.query(
        `INSERT INTO ai_usage (org_id, user_id, call_site, total_tokens, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (org_id, user_id, call_site) DO UPDATE SET total_tokens = ai_usage.total_tokens + $4, updated_at = now()`,
        [orgId, userId, callSite, tokens],
      ),
    );
  } catch (err) {
    console.error("Failed to record AI usage", { orgId, userId, callSite, tokens, err });
  }
}

export interface AiUsageBreakdown {
  embedding: number;
  ask: number;
  summarization: number;
  total: number;
}

/**
 * One user's own running totals, broken down by call site, plus their sum
 * — always all three call sites, defaulted to 0, so the caller (the
 * topbar's usage badge) doesn't need to know the call-site enum itself or
 * handle a row simply not existing yet for a call site the user hasn't
 * triggered.
 */
export async function getAiUsageForUser(orgId: string, userId: string): Promise<AiUsageBreakdown> {
  const rows = await withOrgSession(orgId, (client) =>
    client.query<{ call_site: AiUsageCallSite; total_tokens: string }>(
      "SELECT call_site, total_tokens FROM ai_usage WHERE org_id = $1 AND user_id = $2",
      [orgId, userId],
    ),
  );
  const breakdown: AiUsageBreakdown = { embedding: 0, ask: 0, summarization: 0, total: 0 };
  for (const row of rows.rows) {
    const tokens = Number(row.total_tokens);
    breakdown[row.call_site] = tokens;
    breakdown.total += tokens;
  }
  return breakdown;
}
