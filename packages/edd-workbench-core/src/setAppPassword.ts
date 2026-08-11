import "./loadEnv.js";
import { Client } from "pg";
import { resolveConnectionString, resolveSslConfig } from "./dbConnection.js";

// Automates the one manual step every local-dev setup so far has needed by
// hand (see server/.env.example's docker-exec/psql/ALTER-ROLE instructions):
// 004_org_memberships.sql creates edd_workbench_app with no password at all,
// since a migration file can't safely embed one. In the deployed
// environment this runs as the last step of the migration task (see the CDK
// stack's MigrateTaskDefinition), right after migrate.ts, using the same
// owner-level connection — api/worker's own DB_PASSWORD comes from a
// *different* Secrets Manager secret than the one this reads APP_DB_PASSWORD
// from, so this is what keeps the Postgres role's actual password in sync
// with what Secrets Manager thinks it is.
const connectionString = resolveConnectionString("MIGRATE_DATABASE_URL");
// Reassigned into a definitely-`string` binding right after the guard —
// TypeScript's control-flow narrowing of `process.env.APP_DB_PASSWORD`
// doesn't survive into run()'s closure below (narrowing doesn't cross
// function boundaries), so leaving it as the `string | undefined` original
// would need a non-null assertion at the point of use instead.
const rawAppDbPassword = process.env.APP_DB_PASSWORD;
if (!rawAppDbPassword) {
  throw new Error("APP_DB_PASSWORD environment variable is required");
}
const appDbPassword: string = rawAppDbPassword;

async function run(): Promise<void> {
  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  // ALTER ROLE ... PASSWORD doesn't accept a bind parameter (same DDL
  // limitation as SET — see session.ts's set_config comment for the SET
  // case) — the value comes from Secrets Manager's own generateSecretString
  // (excludePunctuation: true, see the CDK stack), not user input, but this
  // still escapes defensively rather than assuming that always holds.
  const escaped = appDbPassword.replace(/'/g, "''");
  await client.query(`ALTER ROLE edd_workbench_app WITH PASSWORD '${escaped}'`);
  console.log("edd_workbench_app password updated.");
  await client.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
