// Loads apps/edd-workbench/server/.env — deliberately shared with the server,
// not a separate worker/.env, since local dev's Postgres/MinIO/ElasticMQ
// connection details are identical for both processes (there's nothing
// worker-specific to configure differently). Must be the first import, same
// reasoning as index.ts's own comment in the server app: queues.ts's
// sqsClient and the handlers' pool/s3Client all read env vars at
// module-load time.
import "@xbundle/edd-workbench-core/src/loadEnv.js";
import { consumeQueue } from "@xbundle/edd-workbench-core";
import { handleIngestMessage } from "./handlers/ingest.js";
import { handleExportMessage } from "./handlers/export.js";
import { handleEmbeddingMessage } from "./handlers/embedding.js";
import { handleSearchIndexMessage } from "./handlers/searchIndex.js";

const INGEST_QUEUE_URL = process.env.EDD_WORKBENCH_INGEST_QUEUE_URL;
const EXPORT_QUEUE_URL = process.env.EDD_WORKBENCH_EXPORT_QUEUE_URL;
const EMBEDDING_QUEUE_URL = process.env.EDD_WORKBENCH_EMBEDDING_QUEUE_URL;
const SEARCH_INDEX_QUEUE_URL = process.env.EDD_WORKBENCH_SEARCHINDEX_QUEUE_URL;
if (!INGEST_QUEUE_URL || !EXPORT_QUEUE_URL || !EMBEDDING_QUEUE_URL || !SEARCH_INDEX_QUEUE_URL) {
  throw new Error(
    "EDD_WORKBENCH_INGEST_QUEUE_URL, EDD_WORKBENCH_EXPORT_QUEUE_URL, EDD_WORKBENCH_EMBEDDING_QUEUE_URL, and EDD_WORKBENCH_SEARCHINDEX_QUEUE_URL environment variables are required",
  );
}

console.log("EDD Workbench worker starting — consuming ingest, export, embedding, and search-index queues");

// Aborted on SIGTERM (what ECS sends on deploy/scale-down before killing
// the task outright) — consumeQueue's AbortSignal support means this is a
// real graceful shutdown, not just a testability hook: every loop finishes
// whatever single message it's mid-handling, then actually stops, instead
// of the process being killed unconditionally mid-work.
const shutdownController = new AbortController();
process.on("SIGTERM", () => {
  console.log("EDD Workbench worker received SIGTERM — finishing in-flight messages, then stopping");
  shutdownController.abort();
});

// Three independent long-poll loops in one process — embedding added
// alongside ingest/export rather than as its own service (unlike OCR):
// it calls the self-hosted embedding server's own OpenAI-compatible API
// directly (see embeddingClient.ts), with no wrapper service of our own
// to justify separate deployment/scaling infrastructure the way OCR's own
// CPU-bound rasterize-then-recognize work (needing its own container's
// worth of native binaries and resource sizing — see ocr-service's
// Dockerfile/tesseract.ts) did.
await Promise.all([
  consumeQueue(INGEST_QUEUE_URL, "ingest", handleIngestMessage, shutdownController.signal),
  consumeQueue(EXPORT_QUEUE_URL, "export", handleExportMessage, shutdownController.signal),
  consumeQueue(EMBEDDING_QUEUE_URL, "embedding", handleEmbeddingMessage, shutdownController.signal),
  consumeQueue(SEARCH_INDEX_QUEUE_URL, "search-index", handleSearchIndexMessage, shutdownController.signal),
]);

console.log("EDD Workbench worker stopped.");
