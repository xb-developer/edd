import type { PoolClient } from "pg";

/**
 * Hardcoded per-matter storage cap — no per-org/plan variation yet. 3
 * GiB, matching how every other size figure in this codebase
 * (containerExpansion.ts's ZIP_MAX_SIZE_BYTES/SEVEN_ZIP_MAX_SIZE_BYTES) is a
 * binary gigabyte, not a decimal one.
 */
export const MATTER_STORAGE_QUOTA_BYTES = 3 * 1024 * 1024 * 1024;

/**
 * Live SUM over `documents.size_bytes`, not a maintained running counter
 * (unlike matter_guid_counters' per-matter running value) — a counter can
 * only ever grow, while a matter's total needs to shrink on document/matter
 * delete too (documents.ts's deleteDocumentsWithS3Cleanup, matters.ts's own
 * cascade), and `documents.size_bytes` is already the real source of truth
 * for every one of those paths. Must be called inside the same
 * `withOrgSession` transaction as whatever insert(s) it's gating, so the
 * check and the insert(s) it informs are consistent with each other within
 * that transaction — it does not itself guard against a genuinely
 * concurrent upload racing in from a different request/transaction (a soft
 * business-rule cap, not a strictly atomic one, matching this feature's own
 * scope).
 */
export async function getMatterStorageUsedBytes(client: PoolClient, matterId: string): Promise<number> {
  const result = await client.query<{ total: string | null }>("SELECT SUM(size_bytes) AS total FROM documents WHERE matter_id = $1", [matterId]);
  return Number(result.rows[0]?.total ?? 0);
}

/** Human-readable, reused everywhere a quota-rejection message is rendered so wording never drifts between the top-level upload route and the container-member expansion path. */
export function matterQuotaExceededMessage(filename: string): string {
  return `"${filename}" would exceed this matter's 3GB storage quota`;
}
