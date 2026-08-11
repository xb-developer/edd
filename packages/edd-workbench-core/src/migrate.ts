import "./loadEnv.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { resolveConnectionString, resolveSslConfig } from "./dbConnection.js";

// Runs as the RDS master/owner user (or the local docker-compose superuser in
// dev) — deliberately the same connection the app's own pool would use would
// be wrong here, since 004_org_memberships.sql creates the low-privilege
// `edd_workbench_app` role that migrations must NOT run as (a table owner is
// exempt from its own RLS policies, which would make every migration
// silently "work" even if a policy were subtly wrong). Locally that means
// MIGRATE_DATABASE_URL (falling back to DATABASE_URL, since there's only one
// Postgres user in dev anyway); in the deployed migration task (see the CDK
// stack's MigrateTaskDefinition) it means DB_HOST/PORT/USERNAME/PASSWORD
// sourced from the RDS-generated *owner* secret specifically — a
// deliberately different secret than the one api/worker's own DB_USERNAME/
// DB_PASSWORD come from.
const connectionString = resolveConnectionString("MIGRATE_DATABASE_URL");

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

async function run(): Promise<void> {
  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await client.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    console.log(`Applying migration: ${file}`);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`Migration ${file} failed:`, err);
      throw err;
    }
  }

  console.log(files.length === 0 ? "No migrations found." : "All migrations applied.");
  await client.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
