import type { PoolClient } from "pg";

/** Zero-pads a matter-scoped sequence number to the display GUID, e.g. 42 -> "000042". */
export function formatGuid(sequenceNumber: number): string {
  return String(sequenceNumber).padStart(6, "0");
}

/**
 * Creates the counter row for a brand-new matter. Must run in the same
 * transaction as the matter's own INSERT so a counter row always exists
 * before any document import can race to lock it — never created lazily on
 * first import.
 */
export async function initMatterGuidCounter(client: PoolClient, matterId: string): Promise<void> {
  await client.query("INSERT INTO matter_guid_counters (matter_id, next_value) VALUES ($1, 1)", [matterId]);
}

/**
 * Atomically assigns and returns the next sequential GUID number for a
 * matter. The row-level lock this UPDATE takes is exactly what keeps a batch
 * of concurrent uploads from ever skipping or double-assigning a number —
 * see edd-workbench-core/README (or the build plan §3) for why this must run
 * on a pooled, long-lived connection (Fargate) rather than parallel Lambda
 * invocations all racing the same row.
 */
export async function nextMatterGuid(client: PoolClient, matterId: string): Promise<number> {
  const result = await client.query<{ assigned: string }>(
    `UPDATE matter_guid_counters
     SET next_value = next_value + 1
     WHERE matter_id = $1
     RETURNING next_value - 1 AS assigned`,
    [matterId],
  );
  if (result.rowCount === 0) {
    throw new Error(`No GUID counter found for matter ${matterId} — was initMatterGuidCounter() called at matter creation?`);
  }
  return Number(result.rows[0].assigned);
}
