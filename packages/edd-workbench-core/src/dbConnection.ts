// Shared by pool.ts (the app's runtime connection) and migrate.ts (which
// needs a *different* set of credentials — see migrate.ts for why) so the
// two never drift out of sync on how a connection string gets assembled.
//
// Local dev sets a full connection string directly (one Postgres, one
// .env). The deployed ECS tasks instead get DB_HOST/DB_PORT/DB_USERNAME/
// DB_PASSWORD as individual values (see
// infra/edd-workbench/lib/edd-workbench-stack.ts) — RDS's generated-secret
// shape has separate fields, not a ready-made connection string, so it's
// assembled here rather than forcing the stack to fake one up.
export function resolveConnectionString(preferredEnvVar?: string): string {
  if (preferredEnvVar && process.env[preferredEnvVar]) return process.env[preferredEnvVar]!;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const { DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD } = process.env;
  if (DB_HOST && DB_PORT && DB_USERNAME && DB_PASSWORD) {
    return `postgres://${encodeURIComponent(DB_USERNAME)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/edd_workbench`;
  }

  const preferred = preferredEnvVar ? `${preferredEnvVar}, ` : "";
  throw new Error(`Either ${preferred}DATABASE_URL, or DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD together, are required`);
}

// DB_HOST is only ever set by the ECS task environment (see the CDK
// stack) — local dev/test's docker-compose Postgres has no SSL cert
// configured at all, so this only turns SSL on for the real RDS path.
// Needed because RDS's `postgres16` parameter group defaults to
// `rds.force_ssl=1`: a plain connection gets rejected outright with "no
// pg_hba.conf entry ... no encryption", not a slow failure — this bit the
// deployed app for real (every DB-touching request, including the matter
// list, failed) despite working fine locally against docker-compose.
// `rejectUnauthorized: false` encrypts the connection without verifying
// the server certificate against a CA bundle — acceptable here since RDS
// is only reachable from inside the VPC's isolated subnet to begin with,
// but verifying against the real Amazon RDS CA bundle would be the more
// rigorous follow-up for a production (not staging) deployment.
export function resolveSslConfig(): false | { rejectUnauthorized: boolean } {
  return process.env.DB_HOST ? { rejectUnauthorized: false } : false;
}
