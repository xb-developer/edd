import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Client, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool, withOrgSession, initMatterGuidCounter, s3Client, DOCUMENTS_BUCKET, sqsClient } from "@xbundle/edd-workbench-core";
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { CreateQueueCommand, ReceiveMessageCommand, PurgeQueueCommand } from "@aws-sdk/client-sqs";
import { documentsRouter } from "./documents.js";
import type { EddRequestContext } from "../auth.js";

// Mounts only the documents router, with a test-only middleware injecting
// req.eddContext directly — the real requireValidToken/resolveOrgContext
// chain needs a genuine Auth0 JWT, which has no local substitute in this
// project (unlike Postgres/S3/SQS, all of which do). "Authenticated as this
// org/role" is the actual precondition documents.ts's own logic cares
// about; JWT validation itself is express-oauth2-jwt-bearer's concern, not
// re-verified here.
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

// A fresh Client per call, not a shared singleton — this file has more than
// one describe block, and a pg Client can't reconnect after .end(), so a
// module-level singleton closed in one block's afterAll would break the
// next block's cleanup.
async function deleteTestOrg(orgId: string): Promise<void> {
  const client = new Client({ connectionString: "postgres://postgres:postgres@localhost:5432/edd_workbench_test" });
  await client.connect();
  await client.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await client.end();
}

/**
 * Raw document insert for tests that need a row already present (not going
 * through init-upload/ingest). Generates its own id (rather than relying on
 * the table's gen_random_uuid() default) so it can set family_document_id
 * itself — required since migration 018 made that column NOT NULL. None of
 * this file's cases nest more than one level deep, so a childless doc is
 * its own family root and a direct child inherits its parent's own id as
 * family_document_id (valid exactly because the parent is always the root
 * here) — matches documents.ts's real init-upload/ingest.ts's real
 * expandAttachments behavior without needing this helper to handle depth 2+.
 */
async function insertTestDocument(
  client: PoolClient,
  params: {
    orgId: string;
    matterId: string;
    guidNumber: number;
    filename: string;
    extension: string;
    sizeBytes: number;
    s3Key: string | null;
    contentType: string;
    ingestStatus: string;
    parentDocumentId?: string;
    title?: string | null;
    author?: string | null;
    subject?: string | null;
    docDate?: string | null;
    metadata?: unknown;
  },
): Promise<string> {
  const documentId = randomUUID();
  const familyDocumentId = params.parentDocumentId ?? documentId;
  const depth = params.parentDocumentId ? 1 : 0;
  await client.query(
    `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status, title, author, subject, doc_date, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      documentId,
      params.orgId,
      params.matterId,
      params.parentDocumentId ?? null,
      familyDocumentId,
      depth,
      params.guidNumber,
      params.filename,
      params.extension,
      params.sizeBytes,
      params.s3Key,
      params.contentType,
      params.ingestStatus,
      params.title ?? null,
      params.author ?? null,
      params.subject ?? null,
      params.docDate ?? null,
      params.metadata !== undefined ? JSON.stringify(params.metadata) : null,
    ],
  );
  return documentId;
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

// Ends the shared pool once, after every describe block in this file has
// finished — not inside any individual block's own afterAll.
afterAll(async () => {
  await pool.end();
});

describe("documents router — init-upload", () => {
  let orgId: string;
  let userId: string;
  let matterId: string;

  beforeAll(async () => {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
    } catch {
      await s3Client.send(new CreateBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
    }

    ({ orgId, matterId, userId } = await createTestOrgAndMatter("init-upload"));
  });

  afterAll(() => deleteTestOrg(orgId));

  it("assigns sequential GUIDs, creates pending document rows, and returns presigned upload URLs", async () => {
    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });

    const response = await request(app)
      .post(`/api/matters/${matterId}/documents/init-upload`)
      .send({
        files: [
          {
            filename: "witness-statement.docx",
            size: 20480,
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            lastModified: Date.parse("2026-01-05T10:00:00.000Z"),
          },
          { filename: "correspondence.eml", size: 4096, contentType: "message/rfc822" },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body).toHaveLength(2);
    expect(response.body[0].guid).toBe("000001");
    expect(response.body[1].guid).toBe("000002");
    for (const entry of response.body) {
      expect(entry.documentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.uploadUrl).toContain("http");
    }

    const rows = await withOrgSession(orgId, (client) =>
      client.query("SELECT * FROM documents WHERE matter_id = $1 ORDER BY guid_number", [matterId]),
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      original_filename: "witness-statement.docx",
      extension: "docx",
      content_type_detected: "docx",
      ingest_status: "pending",
      size_bytes: "20480",
    });
    expect(rows.rows[1]).toMatchObject({
      original_filename: "correspondence.eml",
      extension: "eml",
      content_type_detected: "eml",
      ingest_status: "pending",
    });
    // file_modified_at: set when the client provides lastModified (matches
    // browser File.lastModified — this is the field the upcoming upload UI
    // will actually populate), left null when omitted.
    expect(new Date(rows.rows[0].file_modified_at).toISOString()).toBe("2026-01-05T10:00:00.000Z");
    expect(rows.rows[1].file_modified_at).toBeNull();
  });

  it("detects the extended format set introduced for the POC-parity migration, including the deliberate ppt/dwg/mpp -> other mapping", async () => {
    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });

    const response = await request(app)
      .post(`/api/matters/${matterId}/documents/init-upload`)
      .send({
        files: [
          { filename: "legacy-memo.doc", size: 1024 },
          { filename: "cover-note.rtf", size: 1024 },
          { filename: "notes.odt", size: 1024 },
          { filename: "figures.ods", size: 1024 },
          { filename: "slides.odp", size: 1024 },
          { filename: "manual.epub", size: 1024 },
          { filename: "page.html", size: 1024 },
          { filename: "custodians.csv", size: 1024 },
          { filename: "scan.tiff", size: 1024 },
          { filename: "legacy-deck.ppt", size: 1024 },
          { filename: "drawing.dwg", size: 1024 },
          { filename: "schedule.mpp", size: 1024 },
        ],
      });

    expect(response.status).toBe(201);

    const rows = await withOrgSession(orgId, (client) =>
      client.query<{ original_filename: string; content_type_detected: string }>(
        "SELECT original_filename, content_type_detected FROM documents WHERE matter_id = $1 AND original_filename LIKE '%.%' ORDER BY guid_number",
        [matterId],
      ),
    );
    const byFilename = Object.fromEntries(rows.rows.map((r) => [r.original_filename, r.content_type_detected]));

    expect(byFilename["legacy-memo.doc"]).toBe("doc");
    expect(byFilename["cover-note.rtf"]).toBe("rtf");
    expect(byFilename["notes.odt"]).toBe("odt");
    expect(byFilename["figures.ods"]).toBe("ods");
    expect(byFilename["slides.odp"]).toBe("odp");
    expect(byFilename["manual.epub"]).toBe("epub");
    expect(byFilename["page.html"]).toBe("html");
    expect(byFilename["custodians.csv"]).toBe("csv");
    expect(byFilename["scan.tiff"]).toBe("tiff");
    expect(byFilename["legacy-deck.ppt"]).toBe("other");
    expect(byFilename["drawing.dwg"]).toBe("other");
    expect(byFilename["schedule.mpp"]).toBe("other");
  });

  it("rejects an empty files array", async () => {
    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).post(`/api/matters/${matterId}/documents/init-upload`).send({ files: [] });
    expect(response.status).toBe(400);
  });
});

describe("documents router — upload-complete", () => {
  let orgId: string;
  let userId: string;
  let matterId: string;
  const ingestQueueUrl = process.env.EDD_WORKBENCH_INGEST_QUEUE_URL!;

  beforeAll(async () => {
    // Idempotent against ElasticMQ, same as real SQS — CreateQueue on an
    // already-existing queue with the same name just returns its URL.
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-ingest-test" }));
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: ingestQueueUrl })).catch(() => {
      // PurgeQueue can only run once per 60s per queue — fine to ignore in a
      // fast local test loop; the queue starts empty on first run regardless.
    });

    ({ orgId, matterId, userId } = await createTestOrgAndMatter("upload-complete"));
  });

  afterAll(() => deleteTestOrg(orgId));

  it("enqueues a real message on the ingest queue for a document that exists", async () => {
    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });

    // Insert a pending document directly — this test is about
    // upload-complete's own behavior, not init-upload's (already covered
    // above), so it doesn't need to go through that endpoint first.
    const documentId = await withOrgSession(orgId, (client) =>
      insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 1,
        filename: "test.eml",
        extension: "eml",
        sizeBytes: 100,
        s3Key: "tenants/x/matters/y/documents/z/original.eml",
        contentType: "eml",
        ingestStatus: "pending",
      }),
    );

    const response = await request(app).post(`/api/matters/${matterId}/documents/${documentId}/upload-complete`).send();
    expect(response.status).toBe(202);

    const { Messages } = await sqsClient.send(
      new ReceiveMessageCommand({ QueueUrl: ingestQueueUrl, WaitTimeSeconds: 2, MaxNumberOfMessages: 1 }),
    );
    expect(Messages).toHaveLength(1);
    expect(JSON.parse(Messages![0].Body!)).toEqual({ documentId, orgId });
  });

  it("404s for a document that doesn't exist", async () => {
    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app)
      .post(`/api/matters/${matterId}/documents/${randomUUID()}/upload-complete`)
      .send();
    expect(response.status).toBe(404);
  });
});

describe("documents router — list", () => {
  // A list, not a single id — the cross-org test creates *two* orgs, and
  // both need guaranteed cleanup regardless of where an assertion fails,
  // not just the "primary" one. Learned this the hard way twice this
  // session already (ingest.test.ts's afterEach fix, and this exact same
  // orgB-cleaned-up-inline mistake actually leaking a real row here).
  let orgIdsToClean: string[] = [];

  afterEach(async () => {
    for (const id of orgIdsToClean) await deleteTestOrg(id);
    orgIdsToClean = [];
  });

  it("lists documents for a matter, ordered by guid, with full row detail", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("list");
    orgIdsToClean.push(orgId);

    await withOrgSession(orgId, async (client) => {
      await insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 2,
        filename: "second.eml",
        extension: "eml",
        sizeBytes: 100,
        s3Key: "k2",
        contentType: "eml",
        ingestStatus: "ready",
        title: "Second subject",
        author: "Bob <bob@example.com>",
        subject: "Second subject",
        docDate: "2026-01-02",
        metadata: { bodyText: "hi" },
      });
      await insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 1,
        filename: "first.pdf",
        extension: "pdf",
        sizeBytes: 200,
        s3Key: "k1",
        contentType: "pdf",
        ingestStatus: "pending",
      });
    });

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/documents`).send();

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    // Ordered by guid ascending, not insertion order (first.pdf was inserted second).
    expect(response.body[0]).toMatchObject({ guid: "000001", originalFilename: "first.pdf", ingestStatus: "pending", title: null });
    expect(response.body[1]).toMatchObject({
      guid: "000002",
      originalFilename: "second.eml",
      ingestStatus: "ready",
      title: "Second subject",
      author: "Bob <bob@example.com>",
    });
    expect(response.body[1].metadata).toEqual({ bodyText: "hi" });
    // No parent — a document with no children is its own family, never null.
    expect(response.body[0].familyGuid).toBe("000001");
    expect(response.body[1].familyGuid).toBe("000002");
  });

  it("resolves familyGuid to the parent's formatted GUID for an attachment expanded into its own document row (depth 1)", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("list-family");
    orgIdsToClean.push(orgId);

    const parentId = await withOrgSession(orgId, async (client) => {
      const parentId = await insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 1,
        filename: "covering-email.eml",
        extension: "eml",
        sizeBytes: 100,
        s3Key: "k1",
        contentType: "eml",
        ingestStatus: "ready",
      });
      await insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 2,
        filename: "attachment.pdf",
        extension: "pdf",
        sizeBytes: 50,
        s3Key: "k2",
        contentType: "pdf",
        ingestStatus: "ready",
        parentDocumentId: parentId,
      });
      return parentId;
    });

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/documents`).send();

    expect(response.status).toBe(200);
    const parentDto = response.body.find((d: { documentId: string }) => d.documentId === parentId);
    const childDto = response.body.find((d: { originalFilename: string }) => d.originalFilename === "attachment.pdf");
    expect(parentDto.familyGuid).toBe(parentDto.guid);
    expect(parentDto.parentGuid).toBeNull();
    expect(childDto.familyGuid).toBe(parentDto.guid);
    expect(childDto.parentGuid).toBe(parentDto.guid);
  });

  // This is the case the original bug (a single self-join one level up,
  // mislabeled "Family GUID") got wrong: at depth 1, "direct parent" and
  // "family root" happen to be the same document, which is exactly why
  // that bug shipped unnoticed — the test above can't distinguish the two
  // formulas. At depth 2, they diverge, and only this test would have
  // caught it.
  it("resolves familyGuid to the family ROOT (not the direct parent) two levels deep, while parentGuid stays the direct parent", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("list-family-depth2");
    orgIdsToClean.push(orgId);

    const { rootId, middleId, leafId } = await withOrgSession(orgId, async (client) => {
      const rootId = await insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 1,
        filename: "mailbox.pst",
        extension: "pst",
        sizeBytes: 100,
        s3Key: "k1",
        contentType: "pst",
        ingestStatus: "ready",
      });
      const middleId = await insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 2,
        filename: "message.eml",
        extension: "eml",
        sizeBytes: 100,
        s3Key: null,
        contentType: "eml",
        ingestStatus: "ready",
        parentDocumentId: rootId,
      });
      // A depth-2 row needs its own explicit family_document_id (the
      // insertTestDocument helper only handles depth <= 1) — set directly,
      // matching how ingest.ts's expandAttachments/handlePstIngest
      // propagate the ROOT's id unchanged to a grandchild, not the
      // immediate parent's id.
      const leafId = randomUUID();
      await client.query(
        `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
         VALUES ($1, $2, $3, $4, $5, 2, 3, 'attachment.jpg', 'jpg', 20, 'k3', 'image', 'ready')`,
        [leafId, orgId, matterId, middleId, rootId],
      );
      return { rootId, middleId, leafId };
    });

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/documents`).send();

    const rootDto = response.body.find((d: { documentId: string }) => d.documentId === rootId);
    const middleDto = response.body.find((d: { documentId: string }) => d.documentId === middleId);
    const leafDto = response.body.find((d: { documentId: string }) => d.documentId === leafId);

    expect(rootDto.familyGuid).toBe(rootDto.guid);
    expect(rootDto.parentGuid).toBeNull();
    expect(middleDto.familyGuid).toBe(rootDto.guid);
    expect(middleDto.parentGuid).toBe(rootDto.guid);
    // The bug: this used to equal middleDto.guid (one level up) instead of
    // the true root.
    expect(leafDto.familyGuid).toBe(rootDto.guid);
    expect(leafDto.parentGuid).toBe(middleDto.guid);
    expect(leafDto.depth).toBe(2);
  });

  it("never returns another organization's documents, even for a real matterId", async () => {
    const { orgId: orgA, userId: userA } = await createTestOrgAndMatter("list-org-a");
    orgIdsToClean.push(orgA);

    const { orgId: orgB, matterId: matterB } = await createTestOrgAndMatter("list-org-b");
    orgIdsToClean.push(orgB);
    await withOrgSession(orgB, (client) =>
      insertTestDocument(client, {
        orgId: orgB,
        matterId: matterB,
        guidNumber: 1,
        filename: "other-org.pdf",
        extension: "pdf",
        sizeBytes: 100,
        s3Key: "k",
        contentType: "pdf",
        ingestStatus: "ready",
      }),
    );

    const app = buildTestApp({ orgId: orgA, userId: userA, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterB}/documents`).send();

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });
});

describe("documents router — view-url", () => {
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

  it("mints a presigned GET URL that actually resolves to the real uploaded bytes", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("view-url");
    orgIdsToClean.push(orgId);

    const s3Key = `tenants/test/documents/${randomUUID()}/original.pdf`;
    const realBytes = Buffer.from("%PDF-1.4 genuine bytes for this test, not a placeholder");
    await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: realBytes }));

    const documentId = await withOrgSession(orgId, (client) =>
      insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 1,
        filename: "bundle.pdf",
        extension: "pdf",
        sizeBytes: realBytes.byteLength,
        s3Key,
        contentType: "pdf",
        ingestStatus: "ready",
      }),
    );

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/documents/${documentId}/view-url`).send();

    expect(response.status).toBe(200);
    expect(response.body.viewUrl).toContain("http");

    // The URL isn't just well-formed — it actually works.
    const fetched = await fetch(response.body.viewUrl);
    expect(fetched.ok).toBe(true);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(realBytes)).toBe(true);
  });

  it("404s for a document that doesn't exist", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("view-url-missing");
    orgIdsToClean.push(orgId);

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/documents/${randomUUID()}/view-url`).send();
    expect(response.status).toBe(404);
  });

  it("409s with a clear message for a document with a null s3_key (e.g. a PST-internal message), instead of an unhandled S3 error", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("view-url-null-s3-key");
    orgIdsToClean.push(orgId);

    const documentId = await withOrgSession(orgId, (client) =>
      insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 1,
        filename: "message-42.eml",
        extension: "eml",
        sizeBytes: 100,
        s3Key: null,
        contentType: "eml",
        ingestStatus: "ready",
      }),
    );

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/documents/${documentId}/view-url`).send();

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "Document has no viewable original file" });
  });

  it("never mints a URL for another organization's document", async () => {
    const { orgId: orgA, userId: userA } = await createTestOrgAndMatter("view-url-org-a");
    orgIdsToClean.push(orgA);

    const { orgId: orgB, matterId: matterB } = await createTestOrgAndMatter("view-url-org-b");
    orgIdsToClean.push(orgB);
    const documentIdB = await withOrgSession(orgB, (client) =>
      insertTestDocument(client, {
        orgId: orgB,
        matterId: matterB,
        guidNumber: 1,
        filename: "other.pdf",
        extension: "pdf",
        sizeBytes: 100,
        s3Key: "k",
        contentType: "pdf",
        ingestStatus: "ready",
      }),
    );

    const app = buildTestApp({ orgId: orgA, userId: userA, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterB}/documents/${documentIdB}/view-url`).send();
    expect(response.status).toBe(404);
  });
});

describe("documents router — get single document", () => {
  let orgIdsToClean: string[] = [];

  afterEach(async () => {
    for (const id of orgIdsToClean) await deleteTestOrg(id);
    orgIdsToClean = [];
  });

  it("returns the full document DTO, matching the pop-out viewer window's re-fetch-by-id needs", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("get-document");
    orgIdsToClean.push(orgId);

    const documentId = await withOrgSession(orgId, (client) =>
      insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 1,
        filename: "bundle.pdf",
        extension: "pdf",
        sizeBytes: 100,
        s3Key: "k",
        contentType: "pdf",
        ingestStatus: "ready",
        title: "Bundle",
      }),
    );

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/documents/${documentId}`).send();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ documentId, originalFilename: "bundle.pdf", title: "Bundle", ingestStatus: "ready" });
  });

  it("404s for a document that doesn't exist", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("get-document-missing");
    orgIdsToClean.push(orgId);

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterId}/documents/${randomUUID()}`).send();
    expect(response.status).toBe(404);
  });

  it("never returns another organization's document", async () => {
    const { orgId: orgA, userId: userA } = await createTestOrgAndMatter("get-document-org-a");
    orgIdsToClean.push(orgA);

    const { orgId: orgB, matterId: matterB } = await createTestOrgAndMatter("get-document-org-b");
    orgIdsToClean.push(orgB);
    const documentIdB = await withOrgSession(orgB, (client) =>
      insertTestDocument(client, {
        orgId: orgB,
        matterId: matterB,
        guidNumber: 1,
        filename: "other.pdf",
        extension: "pdf",
        sizeBytes: 100,
        s3Key: "k",
        contentType: "pdf",
        ingestStatus: "ready",
      }),
    );

    const app = buildTestApp({ orgId: orgA, userId: userA, role: "admin", email: "tester@example.com" });
    const response = await request(app).get(`/api/matters/${matterB}/documents/${documentIdB}`).send();
    expect(response.status).toBe(404);
  });
});

describe("documents router — delete", () => {
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

  it("deletes the document row and its real S3 object", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("delete-doc");
    orgIdsToClean.push(orgId);

    const s3Key = `tenants/test/documents/${randomUUID()}/original.pdf`;
    await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: Buffer.from("real bytes") }));
    const documentId = await withOrgSession(orgId, (client) =>
      insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 1,
        filename: "bundle.pdf",
        extension: "pdf",
        sizeBytes: 100,
        s3Key,
        contentType: "pdf",
        ingestStatus: "ready",
      }),
    );

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).delete(`/api/matters/${matterId}/documents/${documentId}`).send();
    expect(response.status).toBe(204);

    const getResponse = await request(app).get(`/api/matters/${matterId}/documents/${documentId}`).send();
    expect(getResponse.status).toBe(404);

    await expect(s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key }))).rejects.toBeTruthy();
  });

  it("cascade-deletes a document's own expanded attachments (children), including their S3 objects", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("delete-doc-family");
    orgIdsToClean.push(orgId);

    const parentKey = `tenants/test/documents/${randomUUID()}/original.eml`;
    const childKey = `tenants/test/documents/${randomUUID()}/original.pdf`;
    await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: parentKey, Body: Buffer.from("email") }));
    await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: childKey, Body: Buffer.from("attachment") }));

    const { parentId, childId } = await withOrgSession(orgId, async (client) => {
      const parentId = await insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 1,
        filename: "covering-email.eml",
        extension: "eml",
        sizeBytes: 100,
        s3Key: parentKey,
        contentType: "eml",
        ingestStatus: "ready",
      });
      const childId = await insertTestDocument(client, {
        orgId,
        matterId,
        guidNumber: 2,
        filename: "attachment.pdf",
        extension: "pdf",
        sizeBytes: 50,
        s3Key: childKey,
        contentType: "pdf",
        ingestStatus: "ready",
        parentDocumentId: parentId,
      });
      return { parentId, childId };
    });

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).delete(`/api/matters/${matterId}/documents/${parentId}`).send();
    expect(response.status).toBe(204);

    const childRow = await withOrgSession(orgId, (client) => client.query("SELECT id FROM documents WHERE id = $1", [childId]));
    expect(childRow.rowCount).toBe(0);
    await expect(s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: childKey }))).rejects.toBeTruthy();
  });

  it("404s for a document that doesn't exist", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("delete-doc-missing");
    orgIdsToClean.push(orgId);

    const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
    const response = await request(app).delete(`/api/matters/${matterId}/documents/${randomUUID()}`).send();
    expect(response.status).toBe(404);
  });

  it("never deletes another organization's document", async () => {
    const { orgId: orgA, userId: userA } = await createTestOrgAndMatter("delete-doc-org-a");
    orgIdsToClean.push(orgA);

    const { orgId: orgB, matterId: matterB } = await createTestOrgAndMatter("delete-doc-org-b");
    orgIdsToClean.push(orgB);
    const documentIdB = await withOrgSession(orgB, (client) =>
      insertTestDocument(client, {
        orgId: orgB,
        matterId: matterB,
        guidNumber: 1,
        filename: "other.pdf",
        extension: "pdf",
        sizeBytes: 100,
        s3Key: "k",
        contentType: "pdf",
        ingestStatus: "ready",
      }),
    );

    const app = buildTestApp({ orgId: orgA, userId: userA, role: "admin", email: "tester@example.com" });
    const response = await request(app).delete(`/api/matters/${matterB}/documents/${documentIdB}`).send();
    expect(response.status).toBe(404);

    const stillThere = await withOrgSession(orgB, (client) => client.query("SELECT id FROM documents WHERE id = $1", [documentIdB]));
    expect(stillThere.rowCount).toBe(1);
  });
});
