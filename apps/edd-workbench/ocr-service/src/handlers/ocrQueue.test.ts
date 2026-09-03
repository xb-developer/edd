import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { CreateQueueCommand } from "@aws-sdk/client-sqs";
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { withOrgSession, initMatterGuidCounter, sqsClient, s3Client, DOCUMENTS_BUCKET } from "@xbundle/edd-workbench-core";
import { handleOcrMessage } from "./ocrQueue.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
const FIXTURE_PNG = readFileSync(join(FIXTURES_DIR, "scan.png")); // synthetic — see __fixtures__/NOTICE.md

// Explicit, not relying on some other test file's own beforeAll happening
// to run first — a successful OCR now unconditionally enqueues an
// embedding check (see ocrQueue.ts's own hand-off), so this queue must
// exist before this file's success-path test runs. search-index-test is
// needed by BOTH the success and failure paths — a failed OCR still
// enqueues a search-index update so the document stays filename-searchable.
beforeAll(async () => {
  await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-embedding-test" }));
  await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-search-index-test" }));
});

async function deleteTestOrg(orgId: string): Promise<void> {
  await withOrgSession(orgId, (client) => client.query("DELETE FROM matters WHERE org_id = $1", [orgId]));
}

async function ensureBucket(): Promise<void> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
  }
}

async function createTestOrgMatterDocument(s3Key: string | null): Promise<{ orgId: string; documentId: string }> {
  const orgId = `org_test_${randomUUID()}`;

  const documentId = await withOrgSession(orgId, async (client) => {
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
      orgId,
      "ocr queue handler test matter",
    ]);
    const matterId = matterRow.rows[0].id;
    await initMatterGuidCounter(client, matterId);

    const docId = randomUUID();
    await client.query(
      `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
       VALUES ($1, $2, $3, NULL, $1, 0, 1, 'scan.pdf', 'pdf', 100, $4, 'pdf', 'processing')`,
      [docId, orgId, matterId, s3Key],
    );
    return docId;
  });

  return { orgId, documentId };
}

async function getDocument(orgId: string, documentId: string) {
  const row = await withOrgSession(orgId, (client) => client.query("SELECT * FROM documents WHERE id = $1", [documentId]));
  return row.rows[0];
}

describe("handleOcrMessage", () => {
  it("writes the extracted text and marks the document ready on success", async () => {
    await ensureBucket();
    const s3Key = `tenants/test/ocr/${randomUUID()}`;
    await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: FIXTURE_PNG }));
    const { orgId, documentId } = await createTestOrgMatterDocument(s3Key);
    try {
      await handleOcrMessage(JSON.stringify({ documentId, orgId }));

      const doc = await getDocument(orgId, documentId);
      expect(doc.ingest_status).toBe("ready");
      expect(doc.metadata).toEqual({ text: "OCR REGRESSION TEST 482915" });
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("marks the document failed, with the OCR engine's own error recorded, when the object isn't a real image", async () => {
    await ensureBucket();
    const s3Key = `tenants/test/ocr/${randomUUID()}`;
    await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: Buffer.from("this is not an image") }));
    const { orgId, documentId } = await createTestOrgMatterDocument(s3Key);
    try {
      await handleOcrMessage(JSON.stringify({ documentId, orgId }));

      const doc = await getDocument(orgId, documentId);
      expect(doc.ingest_status).toBe("failed");
      expect(doc.ingest_error).toMatch(/cannot be read|error/i);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("does nothing (not an error) when the document has already been deleted", async () => {
    const { orgId, documentId } = await createTestOrgMatterDocument("tenants/test/documents/z/original.pdf");
    await deleteTestOrg(orgId); // gone before the handler ever runs

    await expect(handleOcrMessage(JSON.stringify({ documentId, orgId }))).resolves.toBeUndefined();
  });
});
