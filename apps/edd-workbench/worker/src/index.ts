// Loads apps/edd-workbench/server/.env — deliberately shared with the server,
// not a separate worker/.env, since local dev's Postgres/MinIO/ElasticMQ
// connection details are identical for both processes (there's nothing
// worker-specific to configure differently). Must be the first import, same
// reasoning as index.ts's own comment in the server app: queues.ts's
// sqsClient and the handlers' pool/s3Client all read env vars at
// module-load time.
import "@xbundle/edd-workbench-core/src/loadEnv.js";
import { consumeQueue } from "./queues.js";
import { handleIngestMessage } from "./handlers/ingest.js";
import { handleExportMessage } from "./handlers/export.js";

const INGEST_QUEUE_URL = process.env.EDD_WORKBENCH_INGEST_QUEUE_URL;
const EXPORT_QUEUE_URL = process.env.EDD_WORKBENCH_EXPORT_QUEUE_URL;
if (!INGEST_QUEUE_URL || !EXPORT_QUEUE_URL) {
  throw new Error("EDD_WORKBENCH_INGEST_QUEUE_URL and EDD_WORKBENCH_EXPORT_QUEUE_URL environment variables are required");
}

console.log("EDD Workbench worker starting — consuming ingest and export queues");

// Aborted on SIGTERM (what ECS sends on deploy/scale-down before killing
// the task outright) — consumeQueue's AbortSignal support means this is a
// real graceful shutdown, not just a testability hook: both loops finish
// whatever single message they're mid-handling, then actually stop,
// instead of the process being killed unconditionally mid-work.
const shutdownController = new AbortController();
process.on("SIGTERM", () => {
  console.log("EDD Workbench worker received SIGTERM — finishing in-flight messages, then stopping");
  shutdownController.abort();
});

// Two independent long-poll loops in one process, matching the build plan's
// "one uniform Fargate worker service, two queue consumers" decision (§1) —
// not two separate services, and not per-message Lambda invocations.
await Promise.all([
  consumeQueue(INGEST_QUEUE_URL, handleIngestMessage, shutdownController.signal),
  consumeQueue(EXPORT_QUEUE_URL, handleExportMessage, shutdownController.signal),
]);

console.log("EDD Workbench worker stopped.");
