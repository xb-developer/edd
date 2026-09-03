import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { CreateQueueCommand, PurgeQueueCommand } from "@aws-sdk/client-sqs";
import { sqsClient, recordTick, recordProcessingStart, recordProcessingResult } from "@xbundle/edd-workbench-core";
import { workerStatusRouter } from "./workerStatus.js";
import type { EddRequestContext } from "../auth.js";

// The app role (used by the pooled connection everywhere else) only has
// SELECT/INSERT/UPDATE on worker_heartbeat — production code never needs
// to delete a row, so there's no DELETE grant to give it. Test-only
// cleanup needs one anyway, so it connects as the DB owner instead, same
// pattern as documents.test.ts's deleteTestOrg.
async function deleteHeartbeatRows(queueNames: string[]): Promise<void> {
  const client = new Client({ connectionString: "postgres://postgres:postgres@localhost:5432/edd_workbench_test" });
  await client.connect();
  await client.query("DELETE FROM worker_heartbeat WHERE queue_name = ANY($1)", [queueNames]);
  await client.end();
}

// Same test-only middleware pattern documents.test.ts uses — the real
// requireValidToken/resolveOrgContext chain needs a genuine Auth0 JWT,
// which has no local substitute in this project.
function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/worker-status", workerStatusRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

function context(role: EddRequestContext["role"]): EddRequestContext {
  return { orgId: randomUUID(), userId: randomUUID(), role, email: "test@example.com" };
}

describe("workerStatusRouter", () => {
  // The route always looks up heartbeats by the literal "ingest"/"export"
  // names (see workerStatus.ts's QUEUES array), so this test necessarily
  // writes to those real rows rather than a test-scoped name — clean them
  // up afterward so they don't carry state into other test files.
  afterEach(async () => {
    await deleteHeartbeatRows(["ingest", "export"]);
  });

  it("returns each configured queue's heartbeat and live SQS depth for a non-admin caller too", async () => {
    process.env.EDD_WORKBENCH_INGEST_QUEUE_URL = "http://localhost:9324/queue/edd-workbench-ingest-test";
    process.env.EDD_WORKBENCH_EXPORT_QUEUE_URL = "http://localhost:9324/queue/edd-workbench-export-test";
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-ingest-test" }));
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-export-test" }));
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: process.env.EDD_WORKBENCH_INGEST_QUEUE_URL })).catch(() => {});
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: process.env.EDD_WORKBENCH_EXPORT_QUEUE_URL })).catch(() => {});

    const app = buildTestApp(context("reviewer"));
    const res = await request(app).get("/api/worker-status");

    expect(res.status).toBe(200);
    expect(res.body.queues.find((q: { name: string }) => q.name === "ingest")).toBeDefined();
  });

  it("returns each configured queue's heartbeat and live SQS depth for an admin caller", async () => {
    process.env.EDD_WORKBENCH_INGEST_QUEUE_URL = "http://localhost:9324/queue/edd-workbench-ingest-test";
    process.env.EDD_WORKBENCH_EXPORT_QUEUE_URL = "http://localhost:9324/queue/edd-workbench-export-test";
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-ingest-test" }));
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-export-test" }));
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: process.env.EDD_WORKBENCH_INGEST_QUEUE_URL })).catch(() => {});
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: process.env.EDD_WORKBENCH_EXPORT_QUEUE_URL })).catch(() => {});

    // Route reads real "ingest"/"export" heartbeat rows — write real
    // activity onto them via the same core functions the worker itself
    // uses, rather than inserting rows by hand.
    await recordTick("ingest");
    await recordProcessingStart("ingest");
    await recordProcessingResult("ingest", true);

    const app = buildTestApp(context("admin"));
    const res = await request(app).get("/api/worker-status");

    expect(res.status).toBe(200);
    const ingest = res.body.queues.find((q: { name: string }) => q.name === "ingest");
    expect(ingest.heartbeat.processedTotal).toBeGreaterThanOrEqual(1);
    expect(ingest.heartbeat.processingStartedAt).toBeNull();
    expect(typeof ingest.approximateMessages).toBe("number");

    const exportQueue = res.body.queues.find((q: { name: string }) => q.name === "export");
    expect(exportQueue).toBeDefined();
    expect(typeof exportQueue.approximateMessages).toBe("number");
  });
});
