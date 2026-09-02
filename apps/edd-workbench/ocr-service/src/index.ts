// Same reasoning as the server/worker apps' own index.ts comments: this
// must be the first import, since consumeQueue's sqsClient and pool.ts
// both read required env vars at module-load time.
import "@xbundle/edd-workbench-core/src/loadEnv.js";
import express from "express";
import { consumeQueue } from "@xbundle/edd-workbench-core";
import { ocrRouter } from "./ocrRoute.js";
import { handleOcrMessage } from "./handlers/ocrQueue.js";

const PORT = process.env.EDD_WORKBENCH_OCR_SERVICE_PORT ? Number(process.env.EDD_WORKBENCH_OCR_SERVICE_PORT) : 4440;
const OCR_QUEUE_URL = process.env.EDD_WORKBENCH_OCR_QUEUE_URL;
if (!OCR_QUEUE_URL) {
  throw new Error("EDD_WORKBENCH_OCR_QUEUE_URL environment variable is required");
}

const app = express();
app.use(express.json());

// Unauthenticated, matching the main server's own /api/health — an
// internal service with no ALB/public exposure, but ECS's own container
// health check still needs an unauthenticated endpoint to hit.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/ocr", ocrRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

console.log("EDD Workbench OCR service starting — REST API + consuming the ocr queue");

// Aborted on SIGTERM, same graceful-shutdown reasoning as the worker app:
// finish whatever single OCR job is in flight, then actually stop.
const shutdownController = new AbortController();
process.on("SIGTERM", () => {
  console.log("EDD Workbench OCR service received SIGTERM — finishing any in-flight job, then stopping");
  shutdownController.abort();
});

const server = app.listen(PORT, () => {
  console.log(`EDD Workbench OCR service listening on http://localhost:${PORT}`);
});

await consumeQueue(OCR_QUEUE_URL, "ocr", handleOcrMessage, shutdownController.signal);

console.log("EDD Workbench OCR service's queue consumer stopped.");
server.close();
