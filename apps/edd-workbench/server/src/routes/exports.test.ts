import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool, withOrgSession, initMatterGuidCounter, s3Client, DOCUMENTS_BUCKET, sqsClient } from "@xbundle/edd-workbench-core";
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { CreateQueueCommand, ReceiveMessageCommand, PurgeQueueCommand } from "@aws-sdk/client-sqs";
import { exportsRouter } from "./exports.js";
import type { EddRequestContext } from "../auth.js";

// Same test-only middleware pattern documents.test.ts uses — the real
// requireValidToken/resolveOrgContext chain needs a genuine Auth0 JWT, which
// has no local substitute in this project.
function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/matters/:matterId/exports", exportsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

async function deleteTestOrg(orgId: string): Promise<void> {
  const client = new Client({ connectionString: "postgres://postgres:postgres@localhost:5432/edd_workbench_test" });
  await client.connect();
  await client.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await client.end();
}

async function createTestOrgAndMatter(namePrefix: string) {
  const orgId = randomUUID();
  await pool.query("INSERT INTO organizations (id, name, auth0_org_id) VALUES ($1, $2, $3)", [
    orgId,
    `${namePrefix} test org`,
    `test-org-${orgId}`,
  ]);

  return withOrgSession(orgId, async (client) => {
    const userRow = await client.query<{ id: string }>(
      "INSERT INTO users (auth0_user_id, email) VALUES ($1, $2) RETURNING id",
      [`auth0|${randomUUID()}`, "tester@example.com"],
    );
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
      orgId,
      `${namePrefix} test matter`,
    ]);
    await initMatterGuidCounter(client, matterRow.rows[0].id);
    return { orgId, matterId: matterRow.rows[0].id, userId: userRow.rows[0].id };
  });
}

async function insertDocument(orgId: string, matterId: string, guidNumber: number): Promise<string> {
  return withOrgSession(orgId, async (client) => {
    const documentId = randomUUID();
    const row = await client.query<{ id: string }>(
      `INSERT INTO documents (id, org_id, matter_id, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status, family_document_id, depth)
       VALUES ($1, $2, $3, $4, 'doc.pdf', 'pdf', 100, 'k', 'pdf', 'ready', $1, 0)
       RETURNING id`,
      [documentId, orgId, matterId, guidNumber],
    );
    return row.rows[0].id;
  });
}

afterAll(async () => {
  await pool.end();
});

describe("exports router — create", () => {
  let orgIdsToClean: string[] = [];
  const exportQueueUrl = process.env.EDD_WORKBENCH_EXPORT_QUEUE_URL!;

  beforeAll(async () => {
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-export-test" }));
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: exportQueueUrl })).catch(() => {
      // PurgeQueue can only run once per 60s per queue — fine to ignore in a
      // fast local test loop.
    });
  });

  afterEach(async () => {
    for (const id of orgIdsToClean) await deleteTestOrg(id);
    orgIdsToClean = [];
  });

  it("creates a pending export job and enqueues a real SQS message", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("export-create");
    orgIdsToClean.push(orgId);
    const documentId = await insertDocument(orgId, matterId, 1);

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app)
      .post(`/api/matters/${matterId}/exports`)
      .send({ kind: "documents", documentIds: [documentId] });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("pending");
    expect(response.body.exportId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await withOrgSession(orgId, (client) =>
      client.query("SELECT * FROM matter_exports WHERE id = $1", [response.body.exportId]),
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ kind: "documents", status: "pending", matter_id: matterId });
    expect(row.rows[0].document_ids).toEqual([documentId]);

    const { Messages } = await sqsClient.send(
      new ReceiveMessageCommand({ QueueUrl: exportQueueUrl, WaitTimeSeconds: 2, MaxNumberOfMessages: 1 }),
    );
    expect(Messages).toHaveLength(1);
    expect(JSON.parse(Messages![0].Body!)).toEqual({ exportId: response.body.exportId, orgId });
  });

  it("allows a litigation_support caller to create an export — this route deliberately has no role gate, unlike the tag-mutating endpoints", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("export-role");
    orgIdsToClean.push(orgId);
    const documentId = await insertDocument(orgId, matterId, 1);

    const app = buildTestApp({ orgId, userId, role: "litigation_support", email: "tester@example.com" });
    const response = await request(app)
      .post(`/api/matters/${matterId}/exports`)
      .send({ kind: "properties", documentIds: [documentId] });

    expect(response.status).toBe(201);
  });

  it("rejects an invalid kind", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("export-bad-kind");
    orgIdsToClean.push(orgId);
    const documentId = await insertDocument(orgId, matterId, 1);

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app)
      .post(`/api/matters/${matterId}/exports`)
      .send({ kind: "everything", documentIds: [documentId] });
    expect(response.status).toBe(400);
  });

  it("rejects an empty documentIds array", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("export-empty");
    orgIdsToClean.push(orgId);

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).post(`/api/matters/${matterId}/exports`).send({ kind: "documents", documentIds: [] });
    expect(response.status).toBe(400);
  });

  it("400s with a clear message when a documentId doesn't belong to this matter, and creates no job row", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("export-foreign-doc");
    orgIdsToClean.push(orgId);
    const realDocumentId = await insertDocument(orgId, matterId, 1);
    const foreignDocumentId = randomUUID(); // belongs to no matter at all

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app)
      .post(`/api/matters/${matterId}/exports`)
      .send({ kind: "documents", documentIds: [realDocumentId, foreignDocumentId] });

    expect(response.status).toBe(400);

    const rows = await withOrgSession(orgId, (client) => client.query("SELECT id FROM matter_exports WHERE matter_id = $1", [matterId]));
    expect(rows.rowCount).toBe(0);
  });
});

describe("exports router — status poll", () => {
  let orgIdsToClean: string[] = [];

  afterEach(async () => {
    for (const id of orgIdsToClean) await deleteTestOrg(id);
    orgIdsToClean = [];
  });

  it("reflects a manually-updated row's status and error", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("export-status");
    orgIdsToClean.push(orgId);
    const documentId = await insertDocument(orgId, matterId, 1);

    const exportId = await withOrgSession(orgId, async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO matter_exports (org_id, matter_id, kind, document_ids, status)
         VALUES ($1, $2, 'properties', $3, 'pending') RETURNING id`,
        [orgId, matterId, [documentId]],
      );
      return row.rows[0].id;
    });

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const pending = await request(app).get(`/api/matters/${matterId}/exports/${exportId}`).send();
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({ exportId, kind: "properties", status: "pending", error: null });

    await withOrgSession(orgId, (client) =>
      client.query("UPDATE matter_exports SET status = 'failed', error = $1 WHERE id = $2", ["boom", exportId]),
    );

    const failed = await request(app).get(`/api/matters/${matterId}/exports/${exportId}`).send();
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual({ exportId, kind: "properties", status: "failed", error: "boom" });
  });

  it("404s for an export that doesn't exist", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("export-status-missing");
    orgIdsToClean.push(orgId);

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/exports/${randomUUID()}`).send();
    expect(response.status).toBe(404);
  });
});

describe("exports router — download-url", () => {
  let orgIdsToClean: string[] = [];

  beforeAll(async () => {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
    } catch {
      await s3Client.send(new CreateBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
    }
  });

  afterEach(async () => {
    for (const id of orgIdsToClean) await deleteTestOrg(id);
    orgIdsToClean = [];
  });

  it("mints a presigned GET URL that actually resolves to the real exported bytes once ready", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("export-download-ready");
    orgIdsToClean.push(orgId);
    const documentId = await insertDocument(orgId, matterId, 1);

    const resultKey = `exports/${orgId}/${matterId}/${randomUUID()}/documents.zip`;
    const realBytes = Buffer.from("PK genuine zip bytes for this test, not a placeholder");
    await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: resultKey, Body: realBytes }));

    const exportId = await withOrgSession(orgId, async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO matter_exports (org_id, matter_id, kind, document_ids, status, result_s3_key, completed_at)
         VALUES ($1, $2, 'documents', $3, 'ready', $4, now()) RETURNING id`,
        [orgId, matterId, [documentId], resultKey],
      );
      return row.rows[0].id;
    });

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/exports/${exportId}/download-url`).send();

    expect(response.status).toBe(200);
    expect(response.body.downloadUrl).toContain("http");

    const fetched = await fetch(response.body.downloadUrl);
    expect(fetched.ok).toBe(true);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(realBytes)).toBe(true);
  });

  it("409s when the export is still pending/processing", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("export-download-pending");
    orgIdsToClean.push(orgId);
    const documentId = await insertDocument(orgId, matterId, 1);

    const exportId = await withOrgSession(orgId, async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO matter_exports (org_id, matter_id, kind, document_ids, status)
         VALUES ($1, $2, 'documents', $3, 'processing') RETURNING id`,
        [orgId, matterId, [documentId]],
      );
      return row.rows[0].id;
    });

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/exports/${exportId}/download-url`).send();
    expect(response.status).toBe(409);
  });

  it("404s for an export that doesn't exist", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("export-download-missing");
    orgIdsToClean.push(orgId);

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/exports/${randomUUID()}/download-url`).send();
    expect(response.status).toBe(404);
  });
});

describe("exports router — cross-org isolation", () => {
  let orgIdsToClean: string[] = [];

  afterEach(async () => {
    for (const id of orgIdsToClean) await deleteTestOrg(id);
    orgIdsToClean = [];
  });

  it("org A cannot poll, download, or otherwise see org B's export job", async () => {
    const { orgId: orgA, userId: userA } = await createTestOrgAndMatter("export-org-a");
    orgIdsToClean.push(orgA);

    const { orgId: orgB, matterId: matterB } = await createTestOrgAndMatter("export-org-b");
    orgIdsToClean.push(orgB);
    const documentIdB = await insertDocument(orgB, matterB, 1);

    const exportIdB = await withOrgSession(orgB, async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO matter_exports (org_id, matter_id, kind, document_ids, status, result_s3_key)
         VALUES ($1, $2, 'documents', $3, 'ready', 'exports/somewhere/documents.zip') RETURNING id`,
        [orgB, matterB, [documentIdB]],
      );
      return row.rows[0].id;
    });

    const appA = buildTestApp({ orgId: orgA, userId: userA, role: "admin", email: "tester@example.com" });

    const statusResponse = await request(appA).get(`/api/matters/${matterB}/exports/${exportIdB}`).send();
    expect(statusResponse.status).toBe(404);

    const downloadResponse = await request(appA).get(`/api/matters/${matterB}/exports/${exportIdB}/download-url`).send();
    expect(downloadResponse.status).toBe(404);

    const createResponse = await request(appA)
      .post(`/api/matters/${matterB}/exports`)
      .send({ kind: "documents", documentIds: [documentIdB] });
    // orgA's session can't see matterB's document row at all under RLS, so
    // the "does every id belong to this matter" check fails, same as any
    // other bad selection — 400, not a leak.
    expect(createResponse.status).toBe(400);
  });
});
