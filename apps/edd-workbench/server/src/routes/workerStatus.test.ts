import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withOrgSession, initMatterGuidCounter, recordTick, recordProcessingStart, recordProcessingResult } from "@xbundle/edd-workbench-core";
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
// requireValidToken/resolveOrgContext/requireMatterAccess chain needs a
// genuine Auth0 JWT and lives at the index.ts mount level, not inside this
// router itself (see auth.test.ts for requireMatterAccess's own coverage).
function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/matters/:matterId/worker-status", workerStatusRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

async function createTestOrgAndMatter(namePrefix: string): Promise<{ orgId: string; userId: string; matterId: string }> {
  const orgId = `org_test_${namePrefix}_${randomUUID()}`;
  const userId = randomUUID();
  const matterId = await withOrgSession(orgId, async (client) => {
    const row = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [orgId, `${namePrefix} matter`]);
    await initMatterGuidCounter(client, row.rows[0].id);
    return row.rows[0].id;
  });
  return { orgId, userId, matterId };
}

async function deleteTestOrg(orgId: string): Promise<void> {
  await withOrgSession(orgId, (client) => client.query("DELETE FROM matters WHERE org_id = $1", [orgId]));
}

async function insertDocument(orgId: string, matterId: string, guidNumber: number, ingestStatus: string): Promise<void> {
  await withOrgSession(orgId, (client) => {
    const documentId = randomUUID();
    return client.query(
      `INSERT INTO documents (id, org_id, matter_id, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status, family_document_id, depth)
       VALUES ($1, $2, $3, $4, 'doc.txt', 'txt', 10, 'tenants/test/x/original.txt', 'text', $5, $1, 0)`,
      [documentId, orgId, matterId, guidNumber, ingestStatus],
    );
  });
}

async function insertExportJob(orgId: string, matterId: string, status: string): Promise<void> {
  await withOrgSession(orgId, (client) =>
    client.query("INSERT INTO matter_exports (org_id, matter_id, kind, document_ids, status) VALUES ($1, $2, 'documents', '{}', $3)", [
      orgId,
      matterId,
      status,
    ]),
  );
}

function context(orgId: string, userId: string, role: EddRequestContext["role"] = "admin"): EddRequestContext {
  return { orgId, userId, role, email: "test@example.com" };
}

describe("workerStatusRouter", () => {
  // The route always looks up heartbeats by the literal "ingest"/"export"
  // names (see workerStatus.ts's QUEUE_NAMES), so this test necessarily
  // writes to those real rows rather than a test-scoped name — clean them
  // up afterward so they don't carry state into other test files.
  afterEach(async () => {
    await deleteHeartbeatRows(["ingest", "export"]);
  });

  it("counts only THIS matter's own documents by ingest_status, not another matter's — even in the same org", async () => {
    const { orgId, userId, matterId } = await createTestOrgAndMatter("worker-status-ingest");
    const other = await createTestOrgAndMatter("worker-status-ingest-other");
    try {
      await insertDocument(orgId, matterId, 1, "pending");
      await insertDocument(orgId, matterId, 2, "processing");
      await insertDocument(orgId, matterId, 3, "ready");
      await insertDocument(orgId, matterId, 4, "ready");
      await insertDocument(orgId, matterId, 5, "failed");
      // Same org, different matter — must never be counted against matterId above.
      await insertDocument(other.orgId, other.matterId, 1, "failed");
      await insertDocument(other.orgId, other.matterId, 2, "failed");

      const app = buildTestApp(context(orgId, userId));
      const res = await request(app).get(`/api/matters/${matterId}/worker-status`);

      expect(res.status).toBe(200);
      const ingest = res.body.queues.find((q: { name: string }) => q.name === "ingest");
      // pending + processing = queued; ready = ok; failed = failed.
      expect(ingest).toMatchObject({ queued: 2, ok: 2, failed: 1 });
    } finally {
      await deleteTestOrg(orgId);
      await deleteTestOrg(other.orgId);
    }
  });

  it("counts only THIS matter's own export jobs by status", async () => {
    const { orgId, userId, matterId } = await createTestOrgAndMatter("worker-status-export");
    const other = await createTestOrgAndMatter("worker-status-export-other");
    try {
      await insertExportJob(orgId, matterId, "pending");
      await insertExportJob(orgId, matterId, "ready");
      await insertExportJob(orgId, matterId, "ready");
      await insertExportJob(orgId, matterId, "failed");
      await insertExportJob(other.orgId, other.matterId, "ready");

      const app = buildTestApp(context(orgId, userId));
      const res = await request(app).get(`/api/matters/${matterId}/worker-status`);

      expect(res.status).toBe(200);
      const exportQueue = res.body.queues.find((q: { name: string }) => q.name === "export");
      expect(exportQueue).toMatchObject({ queued: 1, ok: 2, failed: 1 });
    } finally {
      await deleteTestOrg(orgId);
      await deleteTestOrg(other.orgId);
    }
  });

  it("reports zeroed counts (not an error) for a matter with no documents or exports yet", async () => {
    const { orgId, userId, matterId } = await createTestOrgAndMatter("worker-status-empty");
    try {
      const app = buildTestApp(context(orgId, userId));
      const res = await request(app).get(`/api/matters/${matterId}/worker-status`);

      expect(res.status).toBe(200);
      expect(res.body.queues.find((q: { name: string }) => q.name === "ingest")).toMatchObject({ queued: 0, ok: 0, failed: 0 });
      expect(res.body.queues.find((q: { name: string }) => q.name === "export")).toMatchObject({ queued: 0, ok: 0, failed: 0 });
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("still reports the shared worker process's own liveness — global, not matter-scoped, by design", async () => {
    const { orgId, userId, matterId } = await createTestOrgAndMatter("worker-status-heartbeat");
    try {
      // Route reads the real "ingest" heartbeat row — write real activity
      // onto it via the same core functions the worker itself uses, rather
      // than inserting a row by hand.
      await recordTick("ingest");
      await recordProcessingStart("ingest");
      await recordProcessingResult("ingest", true);

      const app = buildTestApp(context(orgId, userId));
      const res = await request(app).get(`/api/matters/${matterId}/worker-status`);

      expect(res.status).toBe(200);
      const ingest = res.body.queues.find((q: { name: string }) => q.name === "ingest");
      expect(ingest.heartbeat.lastTickAt).toBeTruthy();
      // recordProcessingResult clears the in-progress marker.
      expect(ingest.heartbeat.processingStartedAt).toBeNull();
      // The old global lifetime counters are gone from the payload
      // entirely now — queued/ok/failed are this matter's own document
      // counts (asserted in the earlier tests), not worker_heartbeat's.
      expect(ingest.heartbeat.processedTotal).toBeUndefined();
      expect(ingest.heartbeat.failedTotal).toBeUndefined();
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("works for a non-admin caller too (behind requireMatterAccess in production — see auth.test.ts)", async () => {
    const { orgId, userId, matterId } = await createTestOrgAndMatter("worker-status-reviewer");
    try {
      const app = buildTestApp(context(orgId, userId, "reviewer"));
      const res = await request(app).get(`/api/matters/${matterId}/worker-status`);
      expect(res.status).toBe(200);
    } finally {
      await deleteTestOrg(orgId);
    }
  });
});
