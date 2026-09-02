import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CreateQueueCommand } from "@aws-sdk/client-sqs";
import { withOrgSession, initMatterGuidCounter, sqsClient } from "@xbundle/edd-workbench-core";
import { textractClient } from "../textract.js";
import { handleOcrMessage } from "./ocrQueue.js";

// Explicit, not relying on some other test file's own beforeAll happening
// to run first — a successful OCR now unconditionally enqueues an
// embedding check (see ocrQueue.ts's own hand-off), so this queue must
// exist before this file's success-path test runs.
beforeAll(async () => {
  await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-embedding-test" }));
});

async function deleteTestOrg(orgId: string): Promise<void> {
  await withOrgSession(orgId, (client) => client.query("DELETE FROM matters WHERE org_id = $1", [orgId]));
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the extracted text and marks the document ready on success", async () => {
    const { orgId, documentId } = await createTestOrgMatterDocument("tenants/test/documents/x/original.pdf");
    try {
      let call = 0;
      const responses = [
        { JobId: "job-1" },
        { JobStatus: "SUCCEEDED", Blocks: [{ BlockType: "LINE", Text: "Scanned page text" }] },
      ];
      vi.spyOn(textractClient, "send").mockImplementation(async () => responses[call++] as never);

      await handleOcrMessage(JSON.stringify({ documentId, orgId }));

      const doc = await getDocument(orgId, documentId);
      expect(doc.ingest_status).toBe("ready");
      expect(doc.metadata).toEqual({ text: "Scanned page text" });
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("marks the document failed, with Textract's own error recorded, when the job fails", async () => {
    const { orgId, documentId } = await createTestOrgMatterDocument("tenants/test/documents/y/original.pdf");
    try {
      let call = 0;
      const responses = [{ JobId: "job-2" }, { JobStatus: "FAILED", StatusMessage: "Unsupported document format" }];
      vi.spyOn(textractClient, "send").mockImplementation(async () => responses[call++] as never);

      await handleOcrMessage(JSON.stringify({ documentId, orgId }));

      const doc = await getDocument(orgId, documentId);
      expect(doc.ingest_status).toBe("failed");
      expect(doc.ingest_error).toBe("Unsupported document format");
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("does nothing (not an error) when the document has already been deleted", async () => {
    const { orgId, documentId } = await createTestOrgMatterDocument("tenants/test/documents/z/original.pdf");
    await deleteTestOrg(orgId); // gone before the handler ever runs

    const send = vi.spyOn(textractClient, "send");
    await expect(handleOcrMessage(JSON.stringify({ documentId, orgId }))).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
