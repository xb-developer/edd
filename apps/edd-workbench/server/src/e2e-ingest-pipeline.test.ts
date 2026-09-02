import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { CreateQueueCommand, PurgeQueueCommand } from "@aws-sdk/client-sqs";
import { pool, withOrgSession, initMatterGuidCounter, s3Client, sqsClient, DOCUMENTS_BUCKET, consumeQueue } from "@xbundle/edd-workbench-core";
import { handleIngestMessage } from "xbundle-edd-workbench-worker/src/handlers/ingest.js";
import { documentsRouter } from "./routes/documents.js";
import type { EddRequestContext } from "./auth.js";

// The one true end-to-end test for this milestone (build plan §8/grilling
// session Q7): every seam above (GUID counter, extractors, HTTP endpoints,
// handleIngestMessage, consumeQueue) already has its own focused tests —
// this exists purely to catch "each piece works alone but they're wired
// together wrong," which no amount of per-seam testing can catch. Spans
// both the server and worker packages deliberately (hence the workspace
// devDependency on xbundle-edd-workbench-worker) — this is inherently a
// cross-app test, not a misplaced unit test.
//
// Same auth bypass as documents.test.ts: mounts documentsRouter directly
// with an injected eddContext rather than the real requireValidToken chain
// — this test is about the document pipeline, not re-verifying JWT
// validation (already out of scope everywhere else in this suite too).
function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/matters/:matterId/documents", documentsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

const INGEST_QUEUE_URL = process.env.EDD_WORKBENCH_INGEST_QUEUE_URL!;

const FIXTURE_EML = Buffer.from(
  [
    'From: "Jane Reviewer" <jane@example.com>',
    "Subject: Full pipeline test message",
    "Date: Mon, 12 Jan 2026 09:30:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "This message went through the real pipeline end to end.",
    "",
  ].join("\r\n"),
  "utf-8",
);

describe("full ingest pipeline (end-to-end)", () => {
  let orgId: string;
  let userId: string;
  let matterId: string;

  beforeAll(async () => {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
    } catch {
      await s3Client.send(new CreateBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
    }
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-ingest-test" }));
    // The real ingest handler now unconditionally enqueues an embedding
    // check once a document reaches 'ready' — this test drives that real
    // handler, so this queue must exist too, not just the ingest one.
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-embedding-test" }));
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: INGEST_QUEUE_URL })).catch(() => {});

    orgId = `org_test_${randomUUID()}`;
    userId = `auth0|${randomUUID()}`;

    ({ matterId } = await withOrgSession(orgId, async (client) => {
      const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
        orgId,
        "e2e pipeline test matter",
      ]);
      await initMatterGuidCounter(client, matterRow.rows[0].id);
      return { matterId: matterRow.rows[0].id };
    }));
  });

  afterAll(async () => {
    await withOrgSession(orgId, async (client) => {
      await client.query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
      await client.query("DELETE FROM matters WHERE org_id = $1", [orgId]);
    });
    await pool.end();
  });

  it("carries a document from init-upload through to a ready row with real S3/SQS/worker involved", async () => {
    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });

    // 1. init-upload — real GUID assignment, real presigned MinIO PUT URL.
    const initResponse = await request(app)
      .post(`/api/matters/${matterId}/documents/init-upload`)
      .send({ files: [{ filename: "pipeline-test.eml", size: FIXTURE_EML.byteLength, contentType: "message/rfc822" }] });
    expect(initResponse.status).toBe(201);
    const { documentId, uploadUrl } = initResponse.body[0];

    // 2. PUT the real file's bytes to MinIO, exactly as a browser would.
    const putResponse = await fetch(uploadUrl, { method: "PUT", body: FIXTURE_EML });
    expect(putResponse.ok).toBe(true);

    // 3. upload-complete — real message onto real ElasticMQ.
    const completeResponse = await request(app)
      .post(`/api/matters/${matterId}/documents/${documentId}/upload-complete`)
      .send();
    expect(completeResponse.status).toBe(202);

    // 4. The worker's real consumeQueue loop picks it up — one message,
    // then stop (AbortSignal, not an infinite loop left running in a test).
    const controller = new AbortController();
    await consumeQueue(
      INGEST_QUEUE_URL,
      "ingest",
      async (body) => {
        await handleIngestMessage(body);
        controller.abort();
      },
      controller.signal,
    );

    // 5. The document reflects a real end-to-end result.
    const row = await withOrgSession(orgId, (client) => client.query("SELECT * FROM documents WHERE id = $1", [documentId]));
    const doc = row.rows[0];
    expect(doc.ingest_status).toBe("ready");
    expect(doc.title).toBe("Full pipeline test message");
    expect(doc.author).toContain("jane@example.com");
    expect(doc.metadata.bodyText.trim()).toBe("This message went through the real pipeline end to end.");
  });
});
