import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import * as XLSX from "@e965/xlsx";
import { Client } from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { pool, withOrgSession, initMatterGuidCounter, nextMatterGuid, s3Client, DOCUMENTS_BUCKET } from "@xbundle/edd-workbench-core";
import { handleIngestMessage } from "./ingest.js";

const FIXTURE_EML = Buffer.from(
  [
    'From: "Jane Reviewer" <jane@example.com>',
    'To: "John Admin" <john@example.com>',
    "Subject: Draft witness statement",
    "Date: Mon, 12 Jan 2026 09:30:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Please review the attached draft.",
    "",
  ].join("\r\n"),
  "utf-8",
);

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const FIXTURE_MSG = readFileSync(join(FIXTURES_DIR, "sent.msg")); // real msgreader fixture — see __fixtures__/NOTICE.md
const FIXTURE_LEGACY_DOC = readFileSync(join(FIXTURES_DIR, "legacy01.doc")); // real word-extractor fixture — see __fixtures__/NOTICE.md
const FIXTURE_MSG_WITH_ATTACHMENTS = readFileSync(join(FIXTURES_DIR, "attachmentsOrder.msg")); // real msgreader fixture, 4 real .docx attachments — see __fixtures__/NOTICE.md

// The PST fixture lives only in edd-workbench-core's own __fixtures__ dir,
// not duplicated here — see that dir's NOTICE.md for why (~22MB combined
// with its sibling enron.pst, an order of magnitude larger than every
// other fixture this project duplicates per-package). enron.pst's own
// folder-walk/subject/attachment-byte assertions live in pst.test.ts,
// closer to the extractor itself; this file only needs one real multi-
// message PST/OST to exercise ingest.ts's own pst branch end-to-end.
const PST_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/edd-workbench-core/src/extractors/__fixtures__",
);
const FIXTURE_MTNMAN_OST = readFileSync(join(PST_FIXTURES_DIR, "mtnman1965@outlook.com.ost")); // real pst-extractor fixture — see that dir's NOTICE.md

async function buildFixtureDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Witness Statement Draft</dc:title>
  <dc:subject>Draft for review</dc:subject>
  <dc:creator>Jane Reviewer</dc:creator>
</cp:coreProperties>`,
  );
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", RELS_XML);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Please review the attached draft.</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

async function buildFixturePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Case Overview Deck</dc:title>
  <dc:creator>Jane Reviewer</dc:creator>
</cp:coreProperties>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function buildFixtureXlsx(): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Name", "Role"],
      ["Jane Reviewer", "Reviewer"],
    ]),
    "Custodians",
  );
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

// Real legacy BIFF8 (.xls) bytes — used to prove the fix for a real bug
// found this session: the xlsx branch used to also call extractOfficeMetadata
// (JSZip-based) for title/author/subject, which silently returned nulls for
// any genuine .xls upload since a BIFF binary isn't a zip at all.
function buildFixtureLegacyXls(): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Name", "Role"], ["Jane Reviewer", "Reviewer"]]), "Custodians");
  workbook.Props = { Title: "Custodian Log", Author: "Jane Reviewer" };
  return XLSX.write(workbook, { type: "buffer", bookType: "biff8" });
}

async function buildFixtureDocxDisguisedAsDoc(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", RELS_XML);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Please review the attached draft.</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function ensureBucket(): Promise<void> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
  }
}

async function deleteTestOrg(orgId: string): Promise<void> {
  const client = new Client({ connectionString: "postgres://postgres:postgres@localhost:5432/edd_workbench_test" });
  await client.connect();
  await client.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await client.end();
}

/** Creates an org/matter/document row, optionally uploading a real body to S3 at its s3_key first (skipped when body is null, to exercise the "object doesn't exist" failure path). `sizeBytesOverride` lets a test set a size_bytes value independent of the real body's own length (e.g. to exercise the pst pre-flight size-ceiling check without uploading/downloading an actual oversized file). */
async function setupDocument(params: {
  filename: string;
  contentTypeDetected: string;
  body: Buffer | null;
  sizeBytesOverride?: number;
}): Promise<{ orgId: string; documentId: string }> {
  await ensureBucket();

  const s3Key = `tenants/test/documents/${randomUUID()}/original.${params.filename.split(".").pop()}`;
  if (params.body) {
    await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: params.body }));
  }

  const orgId = randomUUID();
  await pool.query("INSERT INTO organizations (id, name, auth0_org_id) VALUES ($1, $2, $3)", [
    orgId,
    "ingest handler test org",
    `test-org-${orgId}`,
  ]);

  const documentId = await withOrgSession(orgId, async (client) => {
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
      orgId,
      "Ingest handler test matter",
    ]);
    // Every real matter gets this at creation time (see matters.ts's own
    // insert route) — needed here now that attachment expansion calls
    // nextMatterGuid() on this same matter, which throws without it.
    await initMatterGuidCounter(client, matterRow.rows[0].id);
    // Assigned via the real counter, not hardcoded to 1 — a hardcoded
    // guid_number bypasses the counter entirely, so the *first* real
    // nextMatterGuid() call (e.g. for an expanded attachment) would
    // independently produce 1 too and collide on the UNIQUE(matter_id,
    // guid_number) constraint, aborting the whole transaction. Matches how
    // every document, top-level or not, really gets its GUID in production.
    const guidNumber = await nextMatterGuid(client, matterRow.rows[0].id);
    // Generated explicitly (not left to the table's gen_random_uuid()
    // default) so it can also be used as family_document_id — a top-level
    // document is the root of its own family, matching documents.ts's
    // real init-upload route exactly.
    const documentId = randomUUID();
    await client.query(
      `INSERT INTO documents (id, org_id, matter_id, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status, family_document_id, depth)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $1, 0)`,
      [
        documentId,
        orgId,
        matterRow.rows[0].id,
        guidNumber,
        params.filename,
        params.filename.split(".").pop(),
        params.sizeBytesOverride ?? params.body?.byteLength ?? 0,
        s3Key,
        params.contentTypeDetected,
      ],
    );
    return documentId;
  });

  return { orgId, documentId };
}

async function readS3ObjectBytes(key: string): Promise<Buffer> {
  const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of object.Body as AsyncIterable<Buffer>) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function getDocument(orgId: string, documentId: string) {
  const row = await withOrgSession(orgId, (client) => client.query("SELECT * FROM documents WHERE id = $1", [documentId]));
  return row.rows[0];
}

afterAll(async () => {
  await pool.end();
});

describe("handleIngestMessage", () => {
  // Cleanup lives in afterEach, not at the end of each test body — a test
  // that fails an assertion throws before reaching an inline cleanup call
  // at the bottom, leaking that run's org. afterEach always runs
  // regardless of the test's outcome (this bit us for real: the first run
  // of this suite, before the docx/msg/error branches were implemented,
  // left 3 orphaned orgs in the test database from exactly this mistake).
  let currentOrgId: string | undefined;

  afterEach(async () => {
    if (currentOrgId) await deleteTestOrg(currentOrgId);
    currentOrgId = undefined;
  });

  it("extracts eml metadata and marks the document ready", async () => {
    const { orgId, documentId } = await setupDocument({ filename: "draft.eml", contentTypeDetected: "eml", body: FIXTURE_EML });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.title).toBe("Draft witness statement");
    expect(doc.author).toContain("jane@example.com");
    expect(doc.metadata.bodyText.trim()).toBe("Please review the attached draft.");
  });

  it("extracts docx docProps metadata plus body HTML and marks the document ready", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "witness-statement.docx",
      contentTypeDetected: "docx",
      body: await buildFixtureDocx(),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.title).toBe("Witness Statement Draft");
    expect(doc.author).toBe("Jane Reviewer");
    expect(doc.subject).toBe("Draft for review");
    expect(doc.metadata.html).toContain("Please review the attached draft.");
  });

  it("extracts xlsx sheet rows into metadata and marks the document ready", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "custodians.xlsx",
      contentTypeDetected: "xlsx",
      body: buildFixtureXlsx(),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.metadata.sheets).toEqual([
      {
        name: "Custodians",
        rows: [
          ["Name", "Role"],
          ["Jane Reviewer", "Reviewer"],
        ],
      },
    ]);
  });

  it("extracts a real legacy .xls's rows AND title/author (the fix for the silent-metadata-loss bug)", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "custodians.xls",
      contentTypeDetected: "xlsx", // detectContentType folds .xls into the xlsx bucket
      body: buildFixtureLegacyXls(),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.title).toBe("Custodian Log");
    expect(doc.author).toBe("Jane Reviewer");
    expect(doc.metadata.sheets[0].rows).toEqual([
      ["Name", "Role"],
      ["Jane Reviewer", "Reviewer"],
    ]);
  });

  it("extracts a plain .csv upload as a single-sheet grid via the shared xlsx extractor", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "custodians.csv",
      contentTypeDetected: "csv",
      body: Buffer.from("Name,Role\nJane Reviewer,Reviewer\n", "utf-8"),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.metadata.sheets[0].rows).toEqual([
      ["Name", "Role"],
      ["Jane Reviewer", "Reviewer"],
    ]);
  });

  it("extracts a genuine legacy OLE2 .doc via word-extractor, leaving content_type_detected as 'doc'", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "legacy-memo.doc",
      contentTypeDetected: "doc",
      body: FIXTURE_LEGACY_DOC,
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.content_type_detected).toBe("doc");
    expect(doc.metadata.text).toContain("This is a test of reviewing");
  });

  it("detects a real .docx mislabeled as .doc via magic bytes and corrects content_type_detected to 'docx'", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "renamed-witness-statement.doc",
      contentTypeDetected: "doc",
      body: await buildFixtureDocxDisguisedAsDoc(),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.content_type_detected).toBe("docx");
    expect(doc.metadata.html).toContain("Please review the attached draft.");
  });

  it("extracts real RTF content via officeText and marks the document ready", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "cover-note.rtf",
      contentTypeDetected: "rtf",
      body: Buffer.from("{\\rtf1\\ansi Please review the attached draft.}"),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.metadata.text).toBe("Please review the attached draft.");
  });

  it("extracts a real HTML document's title and text via officeText's explicit fileType hint", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "page.html",
      contentTypeDetected: "html",
      body: Buffer.from("<html><head><title>Witness Statement Draft</title></head><body><p>Please review the attached draft.</p></body></html>"),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.title).toBe("Witness Statement Draft");
    expect(doc.metadata.text).toBe("Please review the attached draft.");
  });

  it("extracts pptx docProps metadata only — no body content, matching its client-side rendering path", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "case-overview.pptx",
      contentTypeDetected: "pptx",
      body: await buildFixturePptx(),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.title).toBe("Case Overview Deck");
    expect(doc.metadata).toBeNull();
  });

  it("extracts msg metadata (real Outlook fixture) and marks the document ready", async () => {
    const { orgId, documentId } = await setupDocument({ filename: "sent.msg", contentTypeDetected: "msg", body: FIXTURE_MSG });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.title).toBe("Sent time");
    expect(doc.author).toContain("xmailuser@xmailserver.test");
  });

  it("expands a real .msg's attachments into their own child documents, each with a real GUID and a Family GUID link back to the parent, and each fully processed by re-entering the same handler", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "attachmentsOrder.msg",
      contentTypeDetected: "msg",
      body: FIXTURE_MSG_WITH_ATTACHMENTS,
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const parent = await getDocument(orgId, documentId);
    expect(parent.ingest_status).toBe("ready");

    const children = await withOrgSession(orgId, (client) =>
      client.query(
        "SELECT id, guid_number, original_filename, content_type_detected, parent_document_id, ingest_status FROM documents WHERE parent_document_id = $1 ORDER BY guid_number",
        [documentId],
      ),
    );

    expect(children.rows).toHaveLength(4);
    expect(children.rows.map((r) => r.original_filename)).toEqual(["A.docx", "B.docx", "C.docx", "D.docx"]);
    // Sequential, unique, and all greater than the parent's own guid_number
    // (1) — not asserting strict contiguity (no other document competes
    // for numbers in this single-threaded test, but the feature never
    // promises contiguity under real concurrent uploads either — see
    // expandAttachments's own comment).
    const guidNumbers = children.rows.map((r) => r.guid_number);
    expect(new Set(guidNumbers).size).toBe(4);
    expect(Math.min(...guidNumbers)).toBeGreaterThan(parent.guid_number);
    for (const child of children.rows) {
      expect(child.parent_document_id).toBe(documentId);
      expect(child.content_type_detected).toBe("docx");
    }

    // Each child was enqueued for its own ingest pass — simulate the real
    // worker consuming those messages (this test calls the handler
    // directly rather than running the actual SQS consume loop, matching
    // every other test in this file) and confirm full recursive
    // processing: real .docx files, so mammoth should genuinely extract
    // each one's body text, not just mark it ready with no content.
    for (const child of children.rows) {
      await handleIngestMessage(JSON.stringify({ documentId: child.id, orgId }));
    }
    const processedChildren = await withOrgSession(orgId, (client) =>
      client.query("SELECT ingest_status, metadata FROM documents WHERE parent_document_id = $1 ORDER BY guid_number", [documentId]),
    );
    for (const child of processedChildren.rows) {
      expect(child.ingest_status).toBe("ready");
      expect(typeof child.metadata?.html).toBe("string");
    }
  });

  it("marks pdf/other content types ready with no extraction attempted", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "bundle.pdf",
      contentTypeDetected: "pdf",
      body: Buffer.from("%PDF-1.4 not a real pdf, extraction isn't attempted for this type"),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.title).toBeNull();
    expect(doc.metadata).toBeNull();
  });

  it("marks the document failed, with a recorded error, when the S3 object is missing", async () => {
    // body: null — nothing is ever uploaded to this document's s3_key.
    const { orgId, documentId } = await setupDocument({ filename: "missing.eml", contentTypeDetected: "eml", body: null });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("failed");
    expect(doc.ingest_error).toBeTruthy();
  });

  it("transparently expands a real multi-message .ost: the PST's own row/S3 object disappear, each message becomes its own independent family root", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "mtnman1965@outlook.com.ost",
      contentTypeDetected: "pst",
      body: FIXTURE_MTNMAN_OST,
    });
    currentOrgId = orgId;
    const matterIdRow = await withOrgSession(orgId, (client) =>
      client.query<{ matter_id: string; s3_key: string }>("SELECT matter_id, s3_key FROM documents WHERE id = $1", [documentId]),
    );
    const { matter_id: matterId, s3_key: pstS3Key } = matterIdRow.rows[0];

    await handleIngestMessage(JSON.stringify({ documentId, orgId }));

    // Transparent container: the PST's own row and S3 object are gone on a
    // fully-successful expansion — nothing left to review beyond its now-
    // independent messages (see this file's own top-of-section comment on
    // handlePstIngest).
    const parent = await getDocument(orgId, documentId);
    expect(parent).toBeUndefined();
    await expect(s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: pstS3Key }))).rejects.toBeTruthy();

    // 9 real, non-associated IPM.Note*-class messages across this OST's
    // Inbox/Sent Items/Sync Issues/Deleted Items folders — cross-checked
    // directly against this exact fixture in pst.test.ts's own folder-walk
    // assertions; Contacts/Tasks items in this same file are real but
    // deliberately excluded (see pst.ts's own scope-cut comment). Located
    // by matter + a distinguishing metadata marker, not by parent_document_id
    // — the PST that would have linked them no longer exists.
    const children = await withOrgSession(orgId, (client) =>
      client.query(
        "SELECT id, guid_number, content_type_detected, ingest_status, parent_document_id, family_document_id, depth, s3_key, subject, metadata FROM documents WHERE matter_id = $1 AND metadata->>'source' = 'pst' ORDER BY guid_number",
        [matterId],
      ),
    );
    expect(children.rows).toHaveLength(9);
    for (const child of children.rows) {
      expect(child.content_type_detected).toBe("eml");
      expect(child.ingest_status).toBe("ready");
      expect(child.s3_key).toBeNull();
      // The PST was a top-level upload (its own parent_document_id was
      // null) — each message becomes its own independent family root:
      // no parent, family_document_id = its own id, same depth (0) the PST
      // itself occupied. This is the exact behavior asked for, and the
      // exact case the old "inherit the PST's id" formula got wrong.
      expect(child.parent_document_id).toBeNull();
      expect(child.family_document_id).toBe(child.id);
      expect(child.depth).toBe(0);
      expect(typeof child.metadata.folderPath).toBe("string");
    }

    const subjects = children.rows.map((r) => r.subject);
    expect(subjects).toContain("word attachment");
    expect(subjects).toContain("excel attachment");
    expect(subjects).toContain("never gonna give you up");
    // "Today: workout" really lives in this OST's Deleted Items folder —
    // proves nothing was silently dropped from a preservation standpoint.
    expect(subjects).toContain("Today: workout");
    const deletedItemsMessage = children.rows.find((r) => r.subject === "Today: workout");
    expect(deletedItemsMessage.metadata.folderPath).toBe("Root - Mailbox/IPM_SUBTREE/Deleted Items");

    // Sequential and unique — not strict contiguity (see expandAttachments's
    // own comment on why).
    const guidNumbers = children.rows.map((r) => r.guid_number);
    expect(new Set(guidNumbers).size).toBe(9);
  });

  it("expands a PST message's own real attachment into a grandchild document with real bytes and its own S3 key, family-linked to the MESSAGE (not the deleted PST)", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "mtnman1965@outlook.com.ost",
      contentTypeDetected: "pst",
      body: FIXTURE_MTNMAN_OST,
    });
    currentOrgId = orgId;
    const matterIdRow = await withOrgSession(orgId, (client) =>
      client.query<{ matter_id: string }>("SELECT matter_id FROM documents WHERE id = $1", [documentId]),
    );
    const matterId = matterIdRow.rows[0].matter_id;

    await handleIngestMessage(JSON.stringify({ documentId, orgId }));

    const wordMessage = await withOrgSession(orgId, (client) =>
      client.query<{ id: string; guid_number: number; family_document_id: string; depth: number }>(
        "SELECT id, guid_number, family_document_id, depth FROM documents WHERE matter_id = $1 AND metadata->>'source' = 'pst' AND subject = 'word attachment'",
        [matterId],
      ),
    );
    expect(wordMessage.rowCount).toBe(1);
    const messageDocumentId = wordMessage.rows[0].id;
    // Top-level case: the message's own family is itself, at the same
    // depth (0) the now-deleted PST occupied.
    expect(wordMessage.rows[0].family_document_id).toBe(messageDocumentId);
    expect(wordMessage.rows[0].depth).toBe(0);

    const grandchild = await withOrgSession(orgId, (client) =>
      client.query("SELECT * FROM documents WHERE parent_document_id = $1", [messageDocumentId]),
    );
    expect(grandchild.rows).toHaveLength(1);
    expect(grandchild.rows[0].original_filename).toBe("OBA_2760.doc");
    expect(grandchild.rows[0].content_type_detected).toBe("doc");
    expect(grandchild.rows[0].s3_key).toBeTruthy();

    // Real bytes, fetched back from the real S3 object the expansion
    // actually uploaded — not just a filename/size on the row. Verified
    // against the same sha256 hash pst.test.ts's own attachment-bytes test
    // checks (the original OBA_2760.doc in pst-extractor's own test
    // corpus — see __fixtures__/NOTICE.md).
    const bytes = await readS3ObjectBytes(grandchild.rows[0].s3_key);
    expect(bytes.byteLength).toBe(53760);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "1fc99f9b8479bcbe0504334980bccd172982b951887eec41f0e48127d5d009d8",
    );

    // The grandchild's own GUID sorts after the message document's — same
    // sequential-and-unique property every other expanded child in this
    // file has.
    expect(grandchild.rows[0].guid_number).toBeGreaterThan(wordMessage.rows[0].guid_number);

    // The grandchild's family/parent link the MESSAGE, not the (now
    // deleted) PST — a message is a real node, not transparent, so its own
    // attachments are real children of it, one level deeper.
    expect(grandchild.rows[0].parent_document_id).toBe(messageDocumentId);
    expect(grandchild.rows[0].family_document_id).toBe(messageDocumentId);
    expect(grandchild.rows[0].depth).toBe(1);
  });

  it("a PST arriving nested (as if it were an email's own attachment) passes its messages through to the EMAIL's family, not a fresh independent one", async () => {
    const { orgId, documentId: emailId } = await setupDocument({ filename: "covering-email.eml", contentTypeDetected: "eml", body: null });
    currentOrgId = orgId;
    const matterIdRow = await withOrgSession(orgId, (client) =>
      client.query<{ matter_id: string }>("SELECT matter_id FROM documents WHERE id = $1", [emailId]),
    );
    const matterId = matterIdRow.rows[0].matter_id;

    // Simulates the PST arriving as a real attachment of the email above —
    // parent_document_id/family_document_id/depth set exactly the way
    // expandAttachments would set them for any attachment, since that's
    // genuinely how a .pst attached to an email gets here in production.
    const pstDocumentId = await withOrgSession(orgId, async (client) => {
      await ensureBucket();
      const guidNumber = await nextMatterGuid(client, matterId);
      const pstDocumentId = randomUUID();
      const s3Key = `tenants/test/documents/${pstDocumentId}/original.pst`;
      await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: FIXTURE_MTNMAN_OST }));
      await client.query(
        `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'mailbox.ost', 'ost', $8, $9, 'pst', 'pending')`,
        [pstDocumentId, orgId, matterId, emailId, emailId, 1, guidNumber, FIXTURE_MTNMAN_OST.byteLength, s3Key],
      );
      return pstDocumentId;
    });

    await handleIngestMessage(JSON.stringify({ documentId: pstDocumentId, orgId }));

    // The PST itself is still elided (transparent) even when nested.
    expect(await getDocument(orgId, pstDocumentId)).toBeUndefined();

    const messages = await withOrgSession(orgId, (client) =>
      client.query<{ parent_document_id: string; family_document_id: string; depth: number }>(
        "SELECT parent_document_id, family_document_id, depth FROM documents WHERE matter_id = $1 AND metadata->>'source' = 'pst'",
        [matterId],
      ),
    );
    expect(messages.rows).toHaveLength(9);
    for (const message of messages.rows) {
      // Pass-through, not independent: each message becomes a direct
      // child of the EMAIL (skipping the invisible PST level entirely),
      // joining the email's own family rather than splintering into 9
      // unrelated roots — the nested case this file's own top comment on
      // handlePstIngest calls out as the one most likely to be gotten wrong.
      expect(message.parent_document_id).toBe(emailId);
      expect(message.family_document_id).toBe(emailId);
      expect(message.depth).toBe(1); // same depth the PST itself occupied, not 2
    }
  });

  it("marks a corrupt PST failed, with a recorded error, and creates no child documents at all", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "corrupt.pst",
      contentTypeDetected: "pst",
      body: Buffer.from("not a real pst file at all, just garbage bytes for this test"),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("failed");
    expect(doc.ingest_error).toBeTruthy();

    const children = await withOrgSession(orgId, (client) =>
      client.query("SELECT id FROM documents WHERE parent_document_id = $1", [documentId]),
    );
    expect(children.rows).toHaveLength(0);
  });

  it("fails cleanly with a recorded ingest_error, without ever attempting the S3 download, when size_bytes exceeds the pre-flight ceiling", async () => {
    // body: null — a real object this size is never actually uploaded;
    // the whole point of the pre-flight check is that it runs (and fails)
    // before any download is attempted, so there's nothing to download.
    const oversizedBytes = 81 * 1024 ** 3; // just over PST_MAX_SIZE_BYTES's 80 GiB ceiling
    const { orgId, documentId } = await setupDocument({
      filename: "huge.pst",
      contentTypeDetected: "pst",
      body: null,
      sizeBytesOverride: oversizedBytes,
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("failed");
    expect(doc.ingest_error).toContain(String(oversizedBytes));
  });

  it("transparently expands a real zip: the zip's own row/S3 object disappear, each member becomes its own independent top-level document, fully re-processed", async () => {
    const zip = new JSZip();
    zip.file("exhibit-1.txt", "plain text exhibit");
    zip.file("docs/witness-statement.eml", FIXTURE_EML);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const { orgId, documentId } = await setupDocument({ filename: "production-set.zip", contentTypeDetected: "zip", body: buffer });
    currentOrgId = orgId;
    const matterIdRow = await withOrgSession(orgId, (client) =>
      client.query<{ matter_id: string; s3_key: string }>("SELECT matter_id, s3_key FROM documents WHERE id = $1", [documentId]),
    );
    const { matter_id: matterId, s3_key: zipS3Key } = matterIdRow.rows[0];

    await handleIngestMessage(JSON.stringify({ documentId, orgId }));

    // Transparent: the zip's own row and S3 object are gone.
    expect(await getDocument(orgId, documentId)).toBeUndefined();
    await expect(s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: zipS3Key }))).rejects.toBeTruthy();

    const members = await withOrgSession(orgId, (client) =>
      client.query(
        "SELECT id, original_filename, content_type_detected, ingest_status, parent_document_id, family_document_id, depth, s3_key, metadata FROM documents WHERE matter_id = $1 AND metadata->>'source' = 'zip' ORDER BY guid_number",
        [matterId],
      ),
    );
    expect(members.rows).toHaveLength(2);

    const textMember = members.rows.find((r) => r.original_filename === "exhibit-1.txt");
    expect(textMember.content_type_detected).toBe("text");
    expect(textMember.metadata.zipPath).toBe("exhibit-1.txt");

    const emlMember = members.rows.find((r) => r.original_filename === "witness-statement.eml");
    expect(emlMember.content_type_detected).toBe("eml");
    expect(emlMember.metadata.zipPath).toBe("docs/witness-statement.eml");

    for (const member of members.rows) {
      // Top-level case (the zip was a top-level upload): each member
      // becomes its own independent family root, same depth (0) the zip
      // itself occupied.
      expect(member.parent_document_id).toBeNull();
      expect(member.family_document_id).toBe(member.id);
      expect(member.depth).toBe(0);
      expect(member.s3_key).toBeTruthy();
    }

    // Real bytes, fetched back from the real S3 object the expansion
    // actually uploaded.
    const textBytes = await readS3ObjectBytes(textMember.s3_key);
    expect(textBytes.toString("utf-8")).toBe("plain text exhibit");

    // Each member gets fully re-processed by re-entering this same handler
    // via the queue — the .eml member's own subject/body should already be
    // extracted by the time this test's own sequential handleIngestMessage
    // call chain (init-upload's queue -> this member's own ingest message)
    // has actually run. Since this test drives the handler directly rather
    // than a real SQS consumer loop, run it once more explicitly for the
    // member to prove the recursion contract, matching how the .msg
    // attachment-recursion test elsewhere in this file already does.
    await handleIngestMessage(JSON.stringify({ documentId: emlMember.id, orgId }));
    const processedEmlMember = await getDocument(orgId, emlMember.id);
    expect(processedEmlMember.ingest_status).toBe("ready");
    expect(processedEmlMember.subject).toBe("Draft witness statement");
  });

  it("a zip arriving nested (as if it were an email's own attachment) passes its members through to the EMAIL's family, not a fresh independent one", async () => {
    const zip = new JSZip();
    zip.file("exhibit-1.txt", "nested-zip member");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const { orgId, documentId: emailId } = await setupDocument({ filename: "covering-email.eml", contentTypeDetected: "eml", body: null });
    currentOrgId = orgId;
    const matterIdRow = await withOrgSession(orgId, (client) =>
      client.query<{ matter_id: string }>("SELECT matter_id FROM documents WHERE id = $1", [emailId]),
    );
    const matterId = matterIdRow.rows[0].matter_id;

    // Simulates the zip arriving as a real attachment of the email above —
    // same shape expandAttachments itself would produce for a real .zip
    // attachment.
    const zipDocumentId = await withOrgSession(orgId, async (client) => {
      await ensureBucket();
      const guidNumber = await nextMatterGuid(client, matterId);
      const zipDocumentId = randomUUID();
      const s3Key = `tenants/test/documents/${zipDocumentId}/original.zip`;
      await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: buffer }));
      await client.query(
        `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'exhibits.zip', 'zip', $8, $9, 'zip', 'pending')`,
        [zipDocumentId, orgId, matterId, emailId, emailId, 1, guidNumber, buffer.byteLength, s3Key],
      );
      return zipDocumentId;
    });

    await handleIngestMessage(JSON.stringify({ documentId: zipDocumentId, orgId }));

    expect(await getDocument(orgId, zipDocumentId)).toBeUndefined();

    const members = await withOrgSession(orgId, (client) =>
      client.query<{ parent_document_id: string; family_document_id: string; depth: number }>(
        "SELECT parent_document_id, family_document_id, depth FROM documents WHERE matter_id = $1 AND metadata->>'source' = 'zip'",
        [matterId],
      ),
    );
    expect(members.rows).toHaveLength(1);
    // Pass-through: a direct child of the EMAIL, skipping the invisible
    // zip level entirely.
    expect(members.rows[0].parent_document_id).toBe(emailId);
    expect(members.rows[0].family_document_id).toBe(emailId);
    expect(members.rows[0].depth).toBe(1); // same depth the zip itself occupied
  });

  it("marks a corrupt zip failed, with a recorded error, and creates no member documents at all", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "corrupt.zip",
      contentTypeDetected: "zip",
      body: Buffer.from("not a real zip file at all, just garbage bytes for this test"),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("failed");
    expect(doc.ingest_error).toBeTruthy();

    const members = await withOrgSession(orgId, (client) =>
      client.query("SELECT id FROM documents WHERE parent_document_id = $1", [documentId]),
    );
    expect(members.rows).toHaveLength(0);
  });

  it("fails cleanly with a recorded ingest_error, without ever attempting the S3 download, when a zip's size_bytes exceeds the pre-flight ceiling", async () => {
    const oversizedBytes = 401 * 1024 ** 2; // just over ZIP_MAX_SIZE_BYTES's 400 MiB ceiling
    const { orgId, documentId } = await setupDocument({
      filename: "huge.zip",
      contentTypeDetected: "zip",
      body: null,
      sizeBytesOverride: oversizedBytes,
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("failed");
    expect(doc.ingest_error).toContain(String(oversizedBytes));
  });
});
