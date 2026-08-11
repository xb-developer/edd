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

/**
 * Runs `fn` inside one transaction with `app.current_user_id`/
 * `app.current_user_email` set from a validated JWT's own claims — the
 * counterpart to withOrgSession for the one moment `orgId` genuinely isn't
 * known yet: resolving which org(s) a brand-new request's caller belongs to
 * in the first place (see auth.ts's resolveOrgContext). Auth0 Organizations
 * would normally hand the server a trusted org_id claim up front, making
 * that lookup free; without it (see migration 007's comment for why), the
 * server has to ask "which orgs is this identity a member of," which is
 * itself a query against an RLS-protected table — hence this second,
 * identity-scoped session variable pair rather than the org-scoped one.
 * Upserts the `users` row itself (rather than leaving that to the caller)
 * because the row must exist before `userId` can even be read back to set
 * `app.current_user_id` — every caller of this function needs that upsert
 * anyway, so it isn't a case of hiding a surprising side effect.
 */
export async function withUserIdentitySession<T>(
  identity: { auth0UserId: string; email: string },
  fn: (client: PoolClient, userId: string) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userRow = await client.query<{ id: string }>(
      `INSERT INTO users (auth0_user_id, email)
       VALUES ($1, $2)
       ON CONFLICT (auth0_user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [identity.auth0UserId, identity.email],
    );
    const userId = userRow.rows[0].id;
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.current_user_email', $1, true)", [identity.email]);
    const result = await fn(client, userId);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
