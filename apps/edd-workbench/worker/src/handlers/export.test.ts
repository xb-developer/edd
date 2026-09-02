import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { GetObjectCommand, PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { pool, withOrgSession, initMatterGuidCounter, nextMatterGuid, s3Client, DOCUMENTS_BUCKET, formatGuid } from "@xbundle/edd-workbench-core";
import { handleExportMessage } from "./export.js";

async function ensureBucket(): Promise<void> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
  }
}

async function deleteTestOrg(orgId: string): Promise<void> {
  await withOrgSession(orgId, (client) => client.query("DELETE FROM matters WHERE org_id = $1", [orgId]));
}

async function createTestOrgAndMatter(namePrefix: string) {
  const orgId = `org_test_${randomUUID()}`;

  return withOrgSession(orgId, async (client) => {
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
      orgId,
      `${namePrefix} test matter`,
    ]);
    await initMatterGuidCounter(client, matterRow.rows[0].id);
    return { orgId, matterId: matterRow.rows[0].id };
  });
}

/** Inserts a document row (with a real guid via the real counter) and, unless body is null, uploads real bytes to S3 at its s3_key. */
async function insertDocument(params: {
  orgId: string;
  matterId: string;
  filename: string;
  extension: string;
  parentDocumentId?: string;
  body: Buffer | null;
}): Promise<{ documentId: string; guidNumber: number }> {
  await ensureBucket();
  const s3Key = params.body ? `tenants/test/documents/${randomUUID()}/original.${params.extension}` : null;
  if (params.body && s3Key) {
    await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: params.body }));
  }

  return withOrgSession(params.orgId, async (client) => {
    const guidNumber = await nextMatterGuid(client, params.matterId);
    // A top-level document is its own family root; a child inherits its
    // parent's own id as family_document_id — valid here since none of
    // this file's cases nest more than one level deep (the parent is
    // always the root), matching documents.test.ts's own helper.
    const documentId = randomUUID();
    const familyDocumentId = params.parentDocumentId ?? documentId;
    const depth = params.parentDocumentId ? 1 : 0;
    const row = await client.query<{ id: string }>(
      `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ready')
       RETURNING id`,
      [
        documentId,
        params.orgId,
        params.matterId,
        params.parentDocumentId ?? null,
        familyDocumentId,
        depth,
        guidNumber,
        params.filename,
        params.extension,
        params.body?.byteLength ?? 0,
        s3Key,
        params.extension,
      ],
    );
    return { documentId: row.rows[0].id, guidNumber };
  });
}

async function createExportJob(params: {
  orgId: string;
  matterId: string;
  kind: "documents" | "properties";
  documentIds: string[];
}): Promise<string> {
  return withOrgSession(params.orgId, async (client) => {
    const row = await client.query<{ id: string }>(
      `INSERT INTO matter_exports (org_id, matter_id, kind, document_ids, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [params.orgId, params.matterId, params.kind, params.documentIds],
    );
    return row.rows[0].id;
  });
}

async function getExportJob(orgId: string, exportId: string) {
  const row = await withOrgSession(orgId, (client) => client.query("SELECT * FROM matter_exports WHERE id = $1", [exportId]));
  return row.rows[0];
}

afterAll(async () => {
  await pool.end();
});

describe("handleExportMessage — documents kind", () => {
  let currentOrgId: string | undefined;

  afterEach(async () => {
    if (currentOrgId) await deleteTestOrg(currentOrgId);
    currentOrgId = undefined;
  });

  it("produces a real zip containing exactly the selected documents' real bytes, named by formatted GUID", async () => {
    const { orgId, matterId } = await createTestOrgAndMatter("export-zip");
    currentOrgId = orgId;

    const bodyA = Buffer.from("real bytes for document A");
    const bodyB = Buffer.from("real bytes for document B, definitely different content");
    const docA = await insertDocument({ orgId, matterId, filename: "a.pdf", extension: "pdf", body: bodyA });
    const docB = await insertDocument({ orgId, matterId, filename: "b.eml", extension: "eml", body: bodyB });

    const exportId = await createExportJob({ orgId, matterId, kind: "documents", documentIds: [docA.documentId, docB.documentId] });
    await handleExportMessage(JSON.stringify({ exportId, orgId }));

    const job = await getExportJob(orgId, exportId);
    expect(job.status).toBe("ready");
    expect(job.result_s3_key).toBe(`exports/${orgId}/${matterId}/${exportId}/documents.zip`);
    expect(job.completed_at).toBeTruthy();

    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: job.result_s3_key }));
    const chunks: Buffer[] = [];
    for await (const chunk of object.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    const zipBuffer = Buffer.concat(chunks);

    const zip = await JSZip.loadAsync(zipBuffer);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([`${formatGuid(docA.guidNumber)}.pdf`, `${formatGuid(docB.guidNumber)}.eml`].sort());

    const extractedA = await zip.file(`${formatGuid(docA.guidNumber)}.pdf`)!.async("nodebuffer");
    const extractedB = await zip.file(`${formatGuid(docB.guidNumber)}.eml`)!.async("nodebuffer");
    expect(extractedA.equals(bodyA)).toBe(true);
    expect(extractedB.equals(bodyB)).toBe(true);
  });

  it("still completes successfully, exporting only the documents that still exist, when one selected document has since been deleted", async () => {
    const { orgId, matterId } = await createTestOrgAndMatter("export-zip-deleted");
    currentOrgId = orgId;

    const keptBody = Buffer.from("kept document's real bytes");
    const kept = await insertDocument({ orgId, matterId, filename: "kept.pdf", extension: "pdf", body: keptBody });
    const deleted = await insertDocument({ orgId, matterId, filename: "deleted.pdf", extension: "pdf", body: Buffer.from("gone") });

    const exportId = await createExportJob({ orgId, matterId, kind: "documents", documentIds: [kept.documentId, deleted.documentId] });

    // Delete the second document's row for real, between job creation and
    // export time — document_ids is fixed at creation, so the job still
    // references it, but the worker's query only returns rows that still
    // exist in `documents`.
    await withOrgSession(orgId, (client) => client.query("DELETE FROM documents WHERE id = $1", [deleted.documentId]));

    await handleExportMessage(JSON.stringify({ exportId, orgId }));

    const job = await getExportJob(orgId, exportId);
    expect(job.status).toBe("ready");
    expect(job.error).toBeNull();

    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: job.result_s3_key }));
    const chunks: Buffer[] = [];
    for await (const chunk of object.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(Object.keys(zip.files)).toEqual([`${formatGuid(kept.guidNumber)}.pdf`]);
  });

  it("still completes with a valid (empty) zip when every selected document has since been deleted", async () => {
    const { orgId, matterId } = await createTestOrgAndMatter("export-zip-all-deleted");
    currentOrgId = orgId;

    const gone = await insertDocument({ orgId, matterId, filename: "gone.pdf", extension: "pdf", body: Buffer.from("gone") });
    const exportId = await createExportJob({ orgId, matterId, kind: "documents", documentIds: [gone.documentId] });
    await withOrgSession(orgId, (client) => client.query("DELETE FROM documents WHERE id = $1", [gone.documentId]));

    await handleExportMessage(JSON.stringify({ exportId, orgId }));

    const job = await getExportJob(orgId, exportId);
    expect(job.status).toBe("ready");
    expect(job.error).toBeNull();

    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: job.result_s3_key }));
    const chunks: Buffer[] = [];
    for await (const chunk of object.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(Object.keys(zip.files)).toEqual([]);
  });

  it("names each zip entry by its RENUMBERED tree-order guid, not its raw insertion-order guid_number — and reflects the whole matter's tree even for a partial export", async () => {
    const { orgId, matterId } = await createTestOrgAndMatter("export-zip-renumber");
    currentOrgId = orgId;

    const root = await insertDocument({ orgId, matterId, filename: "root.eml", extension: "eml", body: Buffer.from("root") });
    const nested = await insertDocument({
      orgId,
      matterId,
      filename: "nested.eml",
      extension: "eml",
      parentDocumentId: root.documentId,
      body: Buffer.from("nested"),
    });
    const pdf = await insertDocument({
      orgId,
      matterId,
      filename: "sibling.pdf",
      extension: "pdf",
      parentDocumentId: root.documentId,
      body: Buffer.from("sibling"),
    });
    // nested's own attachment — inserted last (raw guid_number highest),
    // but belongs one level under `nested`, ahead of `pdf` in tree order.
    const attachmentBody = Buffer.from("nested attachment");
    const attachmentS3Key = `tenants/test/documents/${randomUUID()}/original.jpg`;
    await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: attachmentS3Key, Body: attachmentBody }));
    const attachmentId = randomUUID();
    await withOrgSession(orgId, async (client) => {
      const guidNumber = await nextMatterGuid(client, matterId);
      await client.query(
        `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
         VALUES ($1, $2, $3, $4, $5, 2, $6, 'attachment.jpg', 'jpg', $7, $8, 'image', 'ready')`,
        [attachmentId, orgId, matterId, nested.documentId, root.documentId, guidNumber, attachmentBody.byteLength, attachmentS3Key],
      );
    });

    // A partial export — only `pdf` and the nested attachment — must still
    // number them as if the whole matter's tree were computed (1: root,
    // 2: nested, 3: attachment, 4: pdf), not just 1/2 for the two selected.
    const exportId = await createExportJob({ orgId, matterId, kind: "documents", documentIds: [pdf.documentId, attachmentId] });
    await handleExportMessage(JSON.stringify({ exportId, orgId }));

    const job = await getExportJob(orgId, exportId);
    expect(job.status).toBe("ready");

    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: job.result_s3_key }));
    const chunks: Buffer[] = [];
    for await (const chunk of object.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));

    expect(Object.keys(zip.files).sort()).toEqual(["000003.jpg", "000004.pdf"]);
    expect((await zip.file("000003.jpg")!.async("nodebuffer")).equals(attachmentBody)).toBe(true);
  });

  it("marks the job failed, with a recorded error, when a selected document's S3 object doesn't actually exist", async () => {
    const { orgId, matterId } = await createTestOrgAndMatter("export-zip-missing-s3");
    currentOrgId = orgId;

    // body: null — the row is created but nothing is ever uploaded to its s3_key.
    const missing = await insertDocument({ orgId, matterId, filename: "missing.pdf", extension: "pdf", body: null });
    // insertDocument only skips the S3 PUT when body is null, but the
    // document row itself still needs a non-null s3_key to exercise "the
    // object doesn't exist" (as opposed to migration 017's "no s3_key at
    // all" case, which buildDocumentsZip deliberately skips, not fails).
    await withOrgSession(orgId, (client) =>
      client.query("UPDATE documents SET s3_key = $1 WHERE id = $2", [`tenants/test/documents/${randomUUID()}/original.pdf`, missing.documentId]),
    );

    const exportId = await createExportJob({ orgId, matterId, kind: "documents", documentIds: [missing.documentId] });
    await handleExportMessage(JSON.stringify({ exportId, orgId }));

    const job = await getExportJob(orgId, exportId);
    expect(job.status).toBe("failed");
    expect(job.error).toBeTruthy();
  });
});

describe("handleExportMessage — properties kind", () => {
  let currentOrgId: string | undefined;

  afterEach(async () => {
    if (currentOrgId) await deleteTestOrg(currentOrgId);
    currentOrgId = undefined;
  });

  it("produces a real CSV with the expected header and a correct Family GUID column for a parent/child pair", async () => {
    const { orgId, matterId } = await createTestOrgAndMatter("export-csv");
    currentOrgId = orgId;

    const parent = await insertDocument({ orgId, matterId, filename: "cover-email.eml", extension: "eml", body: Buffer.from("email") });
    const child = await insertDocument({
      orgId,
      matterId,
      filename: "attachment.pdf",
      extension: "pdf",
      parentDocumentId: parent.documentId,
      body: Buffer.from("attachment"),
    });

    await withOrgSession(orgId, (client) =>
      client.query(
        "UPDATE documents SET author = 'Jane Reviewer', doc_date = '2026-01-05', metadata = $1 WHERE id = $2",
        [JSON.stringify({ to: "john@example.com", cc: "cc@example.com" }), parent.documentId],
      ),
    );

    // A single tag with no comma in its own name, applied to the child —
    // kept deliberately simple so this test can assert on the CSV's raw
    // text without needing a full CSV parser (csv-stringify only quotes a
    // field when it actually contains a comma/quote/newline).
    const tagId = await withOrgSession(orgId, async (client) => {
      const tagSet = await client.query<{ id: string }>(
        "INSERT INTO tag_sets (org_id, matter_id, name, position) VALUES ($1, $2, 'Review', 0) RETURNING id",
        [orgId, matterId],
      );
      const tag = await client.query<{ id: string }>(
        "INSERT INTO tags (org_id, matter_id, tag_set_id, name, position) VALUES ($1, $2, $3, 'Hot Doc', 0) RETURNING id",
        [orgId, matterId, tagSet.rows[0].id],
      );
      await client.query("INSERT INTO document_tags (document_id, tag_id, org_id, matter_id) VALUES ($1, $2, $3, $4)", [
        child.documentId,
        tag.rows[0].id,
        orgId,
        matterId,
      ]);
      return tag.rows[0].id;
    });
    expect(tagId).toBeTruthy();

    const exportId = await createExportJob({
      orgId,
      matterId,
      kind: "properties",
      documentIds: [parent.documentId, child.documentId],
    });
    await handleExportMessage(JSON.stringify({ exportId, orgId }));

    const job = await getExportJob(orgId, exportId);
    expect(job.status).toBe("ready");
    expect(job.result_s3_key).toBe(`exports/${orgId}/${matterId}/${exportId}/properties.csv`);

    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: job.result_s3_key }));
    const chunks: Buffer[] = [];
    for await (const chunk of object.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    const csvText = Buffer.concat(chunks).toString("utf-8");
    const lines = csvText.trim().split("\n").map((line) => line.trimEnd());

    expect(lines[0]).toBe("GUID,Family GUID,Filename,Type,Size,Date,Date Modified,Author,To,CC,Tags");

    const parentLine = lines.find((line) => line.includes("cover-email.eml"))!;
    const childLine = lines.find((line) => line.includes("attachment.pdf"))!;
    expect(parentLine).toBeTruthy();
    expect(childLine).toBeTruthy();

    // Parent is its own family; the child's Family GUID points back at the
    // parent's real GUID — the same self-join documents.ts's own
    // DOCUMENT_SELECT uses for the equivalent DTO field.
    const parentGuid = formatGuid(parent.guidNumber);
    const childGuid = formatGuid(child.guidNumber);
    expect(parentLine.startsWith(`${parentGuid},${parentGuid},`)).toBe(true);
    expect(childLine.startsWith(`${childGuid},${parentGuid},`)).toBe(true);
    expect(parentLine).toContain("john@example.com");
    expect(parentLine).toContain("cc@example.com");
    expect(childLine).toContain("Hot Doc");

    // The Date column must render as a real ISO date string — node-pg
    // parses a `date` column into a genuine JS Date, and csv-stringify's
    // own default cast for a Date value is getTime() (a raw
    // epoch-millisecond number), which would be silently useless to a
    // reviewer opening this CSV. formatDateCell (export.ts) is what avoids
    // that.
    expect(parentLine).toContain("2026-01-05T00:00:00.000Z");
    expect(parentLine).not.toMatch(/,\d{10,},/); // no raw epoch-ms number anywhere in this row
  });

  // Two levels deep, "direct parent" and "family root" are different
  // documents — the case the old parent_document_id self-join got wrong
  // (undetectable at depth 1, where they coincide, which is exactly why the
  // original test above never caught it).
  it("resolves the Family GUID column to the family ROOT, not the direct parent, two levels deep", async () => {
    const { orgId, matterId } = await createTestOrgAndMatter("export-csv-family-root");
    currentOrgId = orgId;

    const root = await insertDocument({ orgId, matterId, filename: "mailbox.pst", extension: "pst", body: Buffer.from("root") });
    const middle = await insertDocument({
      orgId,
      matterId,
      filename: "message.eml",
      extension: "eml",
      parentDocumentId: root.documentId,
      body: Buffer.from("middle"),
    });
    const leafId = randomUUID();
    await withOrgSession(orgId, async (client) => {
      const guidNumber = await nextMatterGuid(client, matterId);
      await client.query(
        `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
         VALUES ($1, $2, $3, $4, $5, 2, $6, 'attachment.jpg', 'jpg', 10, NULL, 'image', 'ready')`,
        [leafId, orgId, matterId, middle.documentId, root.documentId, guidNumber],
      );
    });

    const exportId = await createExportJob({ orgId, matterId, kind: "properties", documentIds: [root.documentId, middle.documentId, leafId] });
    await handleExportMessage(JSON.stringify({ exportId, orgId }));

    const job = await getExportJob(orgId, exportId);
    expect(job.status).toBe("ready");

    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: job.result_s3_key }));
    const chunks: Buffer[] = [];
    for await (const chunk of object.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    const lines = Buffer.concat(chunks)
      .toString("utf-8")
      .trim()
      .split("\n")
      .map((line) => line.trimEnd());

    const leafLine = lines.find((line) => line.includes("attachment.jpg"))!;
    expect(leafLine).toBeTruthy();

    // Renumbered display guids: root=1, middle=2, leaf=3 (insertion order
    // already matches tree order here, so raw and computed coincide).
    expect(leafLine.startsWith("000003,000001,")).toBe(true); // leaf's own GUID, then the ROOT's — not middle's (000002)
  });
});
