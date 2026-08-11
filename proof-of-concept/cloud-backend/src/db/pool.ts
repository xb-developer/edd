import { Pool } from "pg";
import "dotenv/config";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env and fill it in");
}

// RDS's default parameter group rejects unencrypted connections outright
// ("no pg_hba.conf entry ... no encryption") - local dev Postgres has no
// such requirement, so this only turns on for the deployed (production)
// environment rather than unconditionally, which would break local dev.
// rejectUnauthorized:false accepts RDS's certificate without pinning a CA
// bundle - fine for now, revisit if stricter cert validation is ever needed.
const isProduction = process.env.NODE_ENV === "production";

export const pool = new Pool({
  connectionString,
  ssl: isProduction ? { rejectUnauthorized: false } : undefined,
});

export interface TenantContext {
  organizationId: string | null;
  userId: string | null;
  isPlatformAdmin: boolean;
}

/**
 * Runs `fn` with a dedicated client whose session has the RLS variables set
 * for `context`, inside a transaction (SET LOCAL only applies for the
 * current transaction, which is what keeps this safe on a pooled connection
 * shared across unrelated requests).
 */
export async function withTenantContext<T>(
  context: TenantContext,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [context.organizationId ?? ""]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [context.userId ?? ""]);
    await client.query("SELECT set_config('app.is_platform_admin', $1, true)", [
      context.isPlatformAdmin ? "true" : "false",
    ]);
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
