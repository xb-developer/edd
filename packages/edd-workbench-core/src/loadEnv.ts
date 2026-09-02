import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for local-dev env vars (DATABASE_URL, S3/SQS
// endpoints, Auth0 config, etc.): apps/edd-workbench/server/.env — imported
// by the server, the worker, and edd-workbench-core's own migrate.ts/
// setAppPassword.ts scripts alike, since local Postgres/MinIO/
// ElasticMQ connection details are identical across all of them; there's
// nothing worker-specific (or script-specific) to configure differently.
// Loaded via a path computed from this file's own location, not
// process.cwd() — `npm run <script> --workspace <name>` runs with cwd set
// to *that workspace's own directory*, so a plain dotenv.config() call from
// a script running out of packages/edd-workbench-core would silently look
// for a .env next to itself instead of the server's, and find nothing —
// exactly the bug this file exists to avoid. Side-effecting import only;
// nothing to export.
config({ path: join(dirname(fileURLToPath(import.meta.url)), "../../../apps/edd-workbench/server/.env") });
