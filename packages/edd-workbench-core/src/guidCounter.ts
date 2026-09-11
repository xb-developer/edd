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
/**
 * Reserves `count` consecutive GUID numbers in ONE statement and returns
 * the first. The caller owns [first, first + count).
 *
 * Same row-level lock, same atomicity guarantee as nextMatterGuid — it just
 * takes the lock once instead of `count` times. init-upload previously
 * awaited nextMatterGuid once per file inside its transaction, so a
 * 1,000-file batch was 1,000 sequential round-trips with the matter's
 * counter row locked for the whole span, blocking every concurrent upload
 * to that matter throughout.
 *
 * Reserving up front means a batch that later fails mid-way leaves a gap in
 * the sequence. That was already true of the per-file version (each UPDATE
 * commits its increment as part of the same transaction, and a rollback
 * rolls back all of them) and is harmless either way: the raw guid_number
 * is an ordering key, not a displayed value — what the user sees is
 * recomputed from tree position on every read (see documentTree.ts).
 */
export async function reserveMatterGuidBlock(client: PoolClient, matterId: string, count: number): Promise<number> {
  if (count <= 0) throw new Error(`reserveMatterGuidBlock requires a positive count, got ${count}`);
  const result = await client.query<{ first_assigned: string }>(
    `UPDATE matter_guid_counters
     SET next_value = next_value + $2
     WHERE matter_id = $1
     RETURNING next_value - $2 AS first_assigned`,
    [matterId, count],
  );
  if (result.rowCount === 0) {
    throw new Error(`No GUID counter found for matter ${matterId} — was initMatterGuidCounter() called at matter creation?`);
  }
  return Number(result.rows[0].first_assigned);
}

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
