import { Router } from "express";
import { extractTextViaOcr } from "./tesseract.js";

/**
 * The stable, engine-agnostic OCR contract — deliberately knows nothing
 * about documents/orgId/matters, only "OCR this S3 object." The queue
 * handler (ocrQueue.ts, this service's real, primary entry point in
 * production) calls extractTextViaOcr directly, not over HTTP — this
 * route exists so the OCR capability itself is independently reachable/
 * testable/reusable without going through the ingest pipeline at all.
 *
 * A separate module from index.ts (not inlined there) for the same reason
 * documents.ts is separate from the main server's own index.ts: a router
 * with no listen()/queue-consumer side effects of its own can be mounted
 * directly into a throwaway test app via supertest.
 */
export const ocrRouter = Router();

ocrRouter.post("/", async (req, res, next) => {
  try {
    const { s3Bucket, s3Key } = req.body as { s3Bucket?: string; s3Key?: string };
    if (!s3Bucket || !s3Key) {
      res.status(400).json({ error: "s3Bucket and s3Key are required" });
      return;
    }
    const text = await extractTextViaOcr({ bucket: s3Bucket, key: s3Key });
    res.json({ text });
  } catch (err) {
    next(err);
  }
});
