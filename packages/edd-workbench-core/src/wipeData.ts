import "./loadEnv.js";
import { Client } from "pg";
import { resolveConnectionString, resolveSslConfig } from "./dbConnection.js";

// Runs as the DB owner (see migrate.ts's own comment for why) — TRUNCATE on
// every tenant-scoped table needs privileges the low-privilege
// edd_workbench_app role doesn't have on all of them (e.g. audit_log is
// SELECT/INSERT only for that role — see 023_audit_log.sql's own GRANT).
//
// One-off, explicitly destructive admin script: deletes every row from
// every real data table, for every org/matter, with no way to select a
// subset — there is no per-org or per-matter scoping here, deliberately,
// since this is "wipe the whole environment," not an ordinary app
// operation. Never wire this into anything the app itself calls. Run via
// `npm run wipe-data <stack-name>` in infra/edd-workbench (ECS RunTask,
// same "no path from a laptop to RDS" reasoning as migrate.ts/
// reindexSearch.ts).
//
// `schema_migrations` is deliberately NOT included — wiping it would make
// migrate.ts think no migration has ever run and try to re-apply all of
// them against tables that already exist, failing immediately on the
// first CREATE TABLE.
const connectionString = resolveConnectionString("MIGRATE_DATABASE_URL");

// Every real data table as of migration 034 (see each one's own migration
// file) — organizations/users/org_memberships/org_invitations were already
// dropped entirely in 027_auth0_only_identity.sql, so they're not here.
// TRUNCATE ... CASCADE handles FK ordering (e.g. documents/tags/etc. all
// reference matters) in one statement rather than requiring a careful
// child-before-parent DELETE order.
const TABLES = [
  "matters",
  "matter_guid_counters",
  "documents",
  "tag_sets",
  "tags",
  "document_tags",
  "matter_exports",
  "matter_members",
  "audit_log",
  "worker_heartbeat",
  "document_chunks",
  "ai_usage",
];

async function run(): Promise<void> {
  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  try {
    console.log(`Truncating: ${TABLES.join(", ")}`);
    await client.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    console.log("Done — every matter and all associated data has been deleted.");
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
