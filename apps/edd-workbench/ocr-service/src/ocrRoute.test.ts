import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { textractClient } from "./textract.js";
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

describe("POST /ocr", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("400s when s3Bucket or s3Key is missing", async () => {
    const app = buildTestApp();
    const res = await request(app).post("/ocr").send({ s3Key: "only-a-key" });
    expect(res.status).toBe(400);
  });

  it("returns the extracted text for a real bucket/key, calling Textract with exactly that location", async () => {
    let call = 0;
    const responses = [{ JobId: "job-1" }, { JobStatus: "SUCCEEDED", Blocks: [{ BlockType: "LINE", Text: "Routed text" }] }];
    const send = vi.spyOn(textractClient, "send").mockImplementation(async () => responses[call++] as never);

    const app = buildTestApp();
    const res = await request(app).post("/ocr").send({ s3Bucket: "my-bucket", s3Key: "docs/a.pdf" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: "Routed text" });
    expect(send.mock.calls[0][0].input).toEqual({
      DocumentLocation: { S3Object: { Bucket: "my-bucket", Name: "docs/a.pdf" } },
    });
  });

  it("500s with the underlying error surfaced when Textract itself fails", async () => {
    let call = 0;
    const responses = [{ JobId: "job-2" }, { JobStatus: "FAILED", StatusMessage: "Unsupported document format" }];
    vi.spyOn(textractClient, "send").mockImplementation(async () => responses[call++] as never);

    const app = buildTestApp();
    const res = await request(app).post("/ocr").send({ s3Bucket: "b", s3Key: "k" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Unsupported document format");
  });
});
