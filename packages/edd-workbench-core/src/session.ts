import type { PoolClient } from "pg";
import { pool } from "./pool.js";

/**
 * Runs `fn` inside one transaction with `app.current_org_id` set to `orgId`
 * via `SET LOCAL` — every RLS-protected table's policy checks this session
 * variable, so this is the single choke point every tenant-scoped query must
 * go through. `orgId` must already be resolved from a validated JWT (never
 * taken directly from request input) before calling this.
 */
export async function withOrgSession<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Plain `SET LOCAL ... = $1` doesn't accept bind parameters in Postgres
    // (SET's grammar wants a literal, not a placeholder) — set_config() is a
    // normal function call, so it does, and its third argument (`true`) gives
    // the same transaction-local scoping as SET LOCAL.
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
