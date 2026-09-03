import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { s3Client, DOCUMENTS_BUCKET } from "@xbundle/edd-workbench-core";
import { ocrRouter } from "./ocrRoute.js";

// Mounts only the router — no listen()/queue-consumer side effects, same
// pattern the main server's route tests (e.g. documents.test.ts) use to
// test a router in isolation from its app's bootstrap file.
function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/ocr", ocrRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: (err as Error).message ?? "Internal server error" });
  });
  return app;
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const FIXTURE_PNG = readFileSync(join(FIXTURES_DIR, "scan.png")); // synthetic — see __fixtures__/NOTICE.md

async function ensureBucket(): Promise<void> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
  }
}

describe("POST /ocr", () => {
  it("400s when s3Bucket or s3Key is missing", async () => {
    const app = buildTestApp();
    const res = await request(app).post("/ocr").send({ s3Key: "only-a-key" });
    expect(res.status).toBe(400);
  });

  it("returns the extracted text for a real bucket/key, routed through the real Tesseract engine", async () => {
    await ensureBucket();
    const key = `tenants/test/ocr/${randomUUID()}`;
    await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: key, Body: FIXTURE_PNG }));

    const app = buildTestApp();
    const res = await request(app).post("/ocr").send({ s3Bucket: DOCUMENTS_BUCKET, s3Key: key });

    expect(res.status).toBe(200);
    expect(res.body.text).toContain("OCR REGRESSION TEST 482915");
  });

  it("500s with a clear error when the referenced object doesn't exist", async () => {
    const app = buildTestApp();
    const res = await request(app).post("/ocr").send({ s3Bucket: DOCUMENTS_BUCKET, s3Key: `tenants/test/ocr/${randomUUID()}` });

    expect(res.status).toBe(500);
  });
});
