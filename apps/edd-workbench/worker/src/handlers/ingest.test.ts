import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import sevenZip from "7zip-min";
import * as XLSX from "@e965/xlsx";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { CreateQueueCommand, ReceiveMessageCommand, PurgeQueueCommand } from "@aws-sdk/client-sqs";
import { pool, withOrgSession, initMatterGuidCounter, nextMatterGuid, s3Client, sqsClient, DOCUMENTS_BUCKET } from "@xbundle/edd-workbench-core";
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

// A genuine, real-world Outlook message Nick supplied specifically to
// reproduce a real attachment-recursion bug: a forwarded email attached as
// a real message/rfc822 part with no filename param at all — see
// eml.ts's own filenameFor() and eml.test.ts's real-fixture test for the
// root-cause fix this exercises end-to-end at the ingest level. Lives in
// the repo-root test-data/ directory per ONBOARDING.md's own convention
// for real Nick-supplied fixtures.
const FIXTURE_PROCESSING_CHECK_EML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../../../test-data/eml/Processing check.eml"),
);

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

/**
 * A genuine multipart/mixed eml (same hand-written-real-MIME precedent as
 * eml.test.ts's own FIXTURE_EML) whose one attachment is `message/rfc822`
 * — a real forwarded email, base64-encoded — proving eml.ts's own real
 * extraction (not a stub) correctly surfaces it as a real byte attachment
 * for expandAttachments to recurse into, exactly like any other real
 * attachment.
 */
function buildEmlWithRfc822Attachment(bodyText: string, attachmentFilename: string, rawEmlAttachment: Buffer): Buffer {
  return Buffer.from(
    [
      'From: "Jane Reviewer" <jane@example.com>',
      'To: "John Admin" <john@example.com>',
      "Subject: Fwd: see below",
      "Date: Mon, 12 Jan 2026 09:30:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="OUTER-BOUNDARY"',
      "",
      "--OUTER-BOUNDARY",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      bodyText,
      "",
      "--OUTER-BOUNDARY",
      "Content-Type: message/rfc822",
      `Content-Disposition: attachment; filename="${attachmentFilename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      rawEmlAttachment.toString("base64"),
      "--OUTER-BOUNDARY--",
      "",
    ].join("\r\n"),
    "utf-8",
  );
}

/**
 * Builds a genuine .7z archive using 7zip-min's own real `pack()` — same
 * "use the real writer of the format you're testing the reader for"
 * precedent zip's own JSZip-based fixtures already establish, per
 * sevenZip.test.ts's own buildFixtureSevenZip. Packing `${srcDir}/*}`
 * (7-Zip's own wildcard expansion, not the shell's) avoids 7-Zip's default
 * behavior of wrapping the source directory itself as a top-level entry.
 */
async function buildFixtureSevenZip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const srcDir = await mkdtemp(join(tmpdir(), "ingest-7z-src-"));
  const archiveDir = await mkdtemp(join(tmpdir(), "ingest-7z-arch-"));
  try {
    for (const [path, content] of Object.entries(entries)) {
      const fullPath = join(srcDir, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
    }
    const archivePath = join(archiveDir, "archive.7z");
    await sevenZip.pack(join(srcDir, "*"), archivePath);
    return await readFile(archivePath);
  } finally {
    await rm(srcDir, { recursive: true, force: true });
    await rm(archiveDir, { recursive: true, force: true });
  }
}

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

// Minimal, genuinely-valid single-page PDFs (not fixture files — small
// enough to inline) used to exercise the real pdfjs-dist text-layer path
// without needing a binary fixture. One has real text-drawing operators
// (BT/Tj), the other has a byte-empty content stream, standing in for a
// scanned page with no text layer at all — both verified by hand against
// the real extractPdfTextLayer() implementation before use here.
const PDF_WITH_TEXT_LAYER = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 58 >>
stream
BT /F1 18 Tf 10 50 Td (Real embedded text) Tj ET
endstream
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`);

const PDF_WITHOUT_TEXT_LAYER = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 5 0 R >>
endobj
5 0 obj
<< /Length 0 >>
stream

endstream
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`);

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

  const orgId = `org_test_${randomUUID()}`;

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

// Explicit, not relying on some other test file's own beforeAll happening
// to run first (the fragile implicit-ordering pattern this suite already
// had for the ingest-test queue) — almost every test below reaches a
// 'ready' ingest_status, which now unconditionally enqueues an embedding
// check (see ingest.ts's own hand-off), so this queue must exist before
// the very first test in this file runs, not just before some of them.
// search-index-test is the same story — every non-container branch below
// (ready, OCR hand-off, or a caught failure) unconditionally enqueues a
// search-index message too.
beforeAll(async () => {
  await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-embedding-test" }));
  await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-search-index-test" }));
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
        "SELECT id, guid_number, original_filename, content_type_detected, parent_document_id, ingest_status, s3_key FROM documents WHERE parent_document_id = $1 ORDER BY guid_number",
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

    // The DB's content_type_detected being right isn't enough — a viewer
    // relies on the S3 object's own real HTTP Content-Type header (e.g.
    // Chrome's native PDF viewer refuses to render an octet-stream response
    // inline even when the surrounding app knows perfectly well it's a
    // PDF). expandMembers must set this explicitly since, unlike a
    // top-level upload, there's no browser-supplied File.type available.
    const firstChildObject = await s3Client.send(new HeadObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: children.rows[0].s3_key }));
    expect(firstChildObject.ContentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");

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

  it("recurses into a REAL Outlook-forwarded email attached with no filename param at all (a real repro file supplied for this exact bug) — the forwarded message becomes a real 'eml' child, fully re-processed, not silently swallowed as 'other'", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "Processing check.eml",
      contentTypeDetected: "eml",
      body: FIXTURE_PROCESSING_CHECK_EML,
    });
    currentOrgId = orgId;

    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const parent = await getDocument(orgId, documentId);
    expect(parent.ingest_status).toBe("ready");
    expect(parent.subject).toBe("Processing check");

    const children = await withOrgSession(orgId, (client) =>
      client.query(
        "SELECT id, original_filename, content_type_detected, parent_document_id, family_document_id, depth FROM documents WHERE parent_document_id = $1 ORDER BY guid_number",
        [documentId],
      ),
    );
    // 3 real evidentiary attachments on the outer message: the filename-
    // less forwarded email plus its two named PDF siblings — 4 inline
    // cid:-referenced signature images are correctly excluded.
    expect(children.rows).toHaveLength(3);

    const forwarded = children.rows.find((r) => r.original_filename === "unnamed.eml");
    expect(forwarded).toBeTruthy();
    // Before the fix: a bare "unnamed" (no extension) meant
    // detectContentType had nothing to key off, so this landed as
    // content_type_detected = "other" — no extraction, no recursion, the
    // exact bug reported. Now it's correctly classified as a real email.
    expect(forwarded.content_type_detected).toBe("eml");
    expect(forwarded.parent_document_id).toBe(documentId);
    expect(forwarded.family_document_id).toBe(documentId);
    expect(forwarded.depth).toBe(1);

    expect(children.rows.find((r) => r.original_filename === "Blue sky.pdf")?.content_type_detected).toBe("pdf");
    expect(
      children.rows.find((r) => r.original_filename === "PRACTICE DIRECTION 51U - DISCLOSURE PILOT FOR THE BUSINESS AND PROPERTY COURTS.pdf")
        ?.content_type_detected,
    ).toBe("pdf");

    // Full recursion, not just correct classification: re-entering the
    // handler for the forwarded email extracts ITS OWN real metadata and
    // expands ITS OWN 3 real attachments (real WhatsApp photos genuinely
    // embedded in the nested message — 5 sibling inline cid:-referenced
    // images inside it are correctly excluded, same as the outer message).
    await handleIngestMessage(JSON.stringify({ documentId: forwarded.id, orgId }));
    const processedForward = await getDocument(orgId, forwarded.id);
    expect(processedForward.ingest_status).toBe("ready");
    expect(processedForward.subject).toBe("RE: Kitchens and Dishes - Fleet Street");

    const grandchildren = await withOrgSession(orgId, (client) =>
      client.query(
        "SELECT original_filename, content_type_detected, parent_document_id, family_document_id, depth FROM documents WHERE parent_document_id = $1",
        [forwarded.id],
      ),
    );
    expect(grandchildren.rows).toHaveLength(3);
    expect(grandchildren.rows.map((r) => r.original_filename).sort()).toEqual(
      [
        "WhatsApp Image 2026-08-11 at 13.18.26.jpeg",
        "WhatsApp Image 2026-08-11 at 13.18.26 (1).jpeg",
        "WhatsApp Image 2026-08-11 at 13.18.26 (2).jpeg",
      ].sort(),
    );
    for (const grandchild of grandchildren.rows) {
      expect(grandchild.content_type_detected).toBe("image");
      // Real node, one level deeper than the forwarded message, sharing
      // the SAME family as the whole chain's own top-level root.
      expect(grandchild.parent_document_id).toBe(forwarded.id);
      expect(grandchild.family_document_id).toBe(documentId);
      expect(grandchild.depth).toBe(2);
    }
  });

  it("recurses through a real multi-level forwarded-email chain — an email attaching an email attaching an email with a real final attachment — all landing in one shared family with correctly chained depth/parent", async () => {
    // Innermost real leaf: a real email with its own real plain-text
    // attachment, no further nesting.
    const leafEmailWithRealAttachment = Buffer.from(
      [
        'From: "Jane Reviewer" <jane@example.com>',
        'To: "John Admin" <john@example.com>',
        "Subject: Final exhibit",
        "Date: Mon, 12 Jan 2026 09:30:00 +0000",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="LEAF-BOUNDARY"',
        "",
        "--LEAF-BOUNDARY",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "See the final exhibit attached.",
        "",
        "--LEAF-BOUNDARY",
        'Content-Type: text/plain; name="final-exhibit.txt"',
        'Content-Disposition: attachment; filename="final-exhibit.txt"',
        "",
        "final exhibit content",
        "--LEAF-BOUNDARY--",
        "",
      ].join("\r\n"),
      "utf-8",
    );
    const level2 = buildEmlWithRfc822Attachment("Second forward — see the exhibit below.", "level2-forward.eml", leafEmailWithRealAttachment);
    const level1 = buildEmlWithRfc822Attachment("First forward — please review.", "level1-forward.eml", level2);

    const { orgId, documentId: rootId } = await setupDocument({ filename: "root.eml", contentTypeDetected: "eml", body: level1 });
    currentOrgId = orgId;
    const rootDoc = await getDocument(orgId, rootId);

    // Depth 0 -> 1: root's own attachment (level1-forward.eml).
    await handleIngestMessage(JSON.stringify({ documentId: rootId, orgId }));
    const gen1 = await withOrgSession(orgId, (client) =>
      client.query("SELECT * FROM documents WHERE parent_document_id = $1", [rootId]),
    );
    expect(gen1.rows).toHaveLength(1);
    expect(gen1.rows[0].content_type_detected).toBe("eml");
    expect(gen1.rows[0].depth).toBe(1);
    expect(gen1.rows[0].family_document_id).toBe(rootDoc.family_document_id);

    // Depth 1 -> 2: level1's own attachment (level2-forward.eml) — proves
    // recursion goes deeper than one level, not just "one attachment
    // extracted, done."
    await handleIngestMessage(JSON.stringify({ documentId: gen1.rows[0].id, orgId }));
    const gen2 = await withOrgSession(orgId, (client) =>
      client.query("SELECT * FROM documents WHERE parent_document_id = $1", [gen1.rows[0].id]),
    );
    expect(gen2.rows).toHaveLength(1);
    expect(gen2.rows[0].content_type_detected).toBe("eml");
    expect(gen2.rows[0].depth).toBe(2);
    expect(gen2.rows[0].family_document_id).toBe(rootDoc.family_document_id);

    // Depth 2 -> 3: level2's own real attachment is the leaf email, whose
    // own real subject ("Final exhibit") only shows up once its metadata
    // is genuinely extracted — and THAT email's own real attachment
    // (final-exhibit.txt) is what proves recursion goes a full 3 levels
    // deep, not just 2.
    await handleIngestMessage(JSON.stringify({ documentId: gen2.rows[0].id, orgId }));
    const gen2Processed = await getDocument(orgId, gen2.rows[0].id);
    expect(gen2Processed.subject).toBe("Final exhibit");

    const gen3 = await withOrgSession(orgId, (client) =>
      client.query("SELECT * FROM documents WHERE parent_document_id = $1", [gen2.rows[0].id]),
    );
    expect(gen3.rows).toHaveLength(1);
    expect(gen3.rows[0].original_filename).toBe("final-exhibit.txt");
    expect(gen3.rows[0].content_type_detected).toBe("text");
    expect(gen3.rows[0].depth).toBe(3);
    expect(gen3.rows[0].family_document_id).toBe(rootDoc.family_document_id);
    expect(gen3.rows[0].parent_document_id).toBe(gen2.rows[0].id);

    const leafBytes = await readS3ObjectBytes(gen3.rows[0].s3_key);
    expect(leafBytes.toString("utf-8")).toBe("final exhibit content");
  });

  it("stops attachment expansion once MAX_ATTACHMENT_EXPANSION_DEPTH is reached, without failing the message's own extraction", async () => {
    const { orgId, documentId: rootId } = await setupDocument({ filename: "root.eml", contentTypeDetected: "eml", body: null });
    currentOrgId = orgId;
    const matterIdRow = await withOrgSession(orgId, (client) =>
      client.query<{ matter_id: string }>("SELECT matter_id FROM documents WHERE id = $1", [rootId]),
    );
    const matterId = matterIdRow.rows[0].matter_id;

    // A real eml with a real attachment, but inserted directly at the
    // expansion ceiling's own depth (matches this file's established
    // "simulate arriving nested" pattern used for zip/pst elsewhere) — no
    // need to hand-build 5 real nested MIME levels to prove the ceiling
    // itself works.
    const deepDocumentId = await withOrgSession(orgId, async (client) => {
      await ensureBucket();
      const guidNumber = await nextMatterGuid(client, matterId);
      const deepDocumentId = randomUUID();
      const s3Key = `tenants/test/documents/${deepDocumentId}/original.eml`;
      await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: FIXTURE_EML }));
      await client.query(
        `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'deep.eml', 'eml', $8, $9, 'eml', 'pending')`,
        [deepDocumentId, orgId, matterId, rootId, rootId, 5, guidNumber, FIXTURE_EML.byteLength, s3Key],
      );
      return deepDocumentId;
    });

    await handleIngestMessage(JSON.stringify({ documentId: deepDocumentId, orgId }));

    // The message's own metadata extraction still ran (the ceiling only
    // stops attachment EXPANSION, not the message's own processing).
    const deepDoc = await getDocument(orgId, deepDocumentId);
    expect(deepDoc.ingest_status).toBe("ready");
    expect(deepDoc.subject).toBe("Draft witness statement");

    // But no child was created for its real attachment — the ceiling held.
    const children = await withOrgSession(orgId, (client) =>
      client.query("SELECT id FROM documents WHERE parent_document_id = $1", [deepDocumentId]),
    );
    expect(children.rows).toHaveLength(0);
  });

  it("a mid-attachment failure rolls back just that ONE attachment's own row — no orphaned 'pending' document is left behind, and the parent still completes with the OTHER attachment intact", async () => {
    // Real MIME, two real attachments — built directly here (not via
    // eml.test.ts's own FIXTURE_EML, which has only one) so this test
    // controls exactly how many sqsClient.send calls expandAttachments will
    // make, matching them 1:1 against the injected failure below.
    const twoAttachmentEml = Buffer.from(
      [
        'From: "Jane Reviewer" <jane@example.com>',
        'To: "John Admin" <john@example.com>',
        "Subject: Two attachments",
        "Date: Mon, 12 Jan 2026 09:30:00 +0000",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="OUTER-BOUNDARY"',
        "",
        "--OUTER-BOUNDARY",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "See the two attached exhibits.",
        "",
        "--OUTER-BOUNDARY",
        'Content-Type: text/plain; name="exhibit-1.txt"',
        'Content-Disposition: attachment; filename="exhibit-1.txt"',
        "",
        "first exhibit",
        "--OUTER-BOUNDARY",
        'Content-Type: text/plain; name="exhibit-2.txt"',
        'Content-Disposition: attachment; filename="exhibit-2.txt"',
        "",
        "second exhibit",
        "--OUTER-BOUNDARY--",
        "",
      ].join("\r\n"),
      "utf-8",
    );

    const { orgId, documentId } = await setupDocument({ filename: "two-attachments.eml", contentTypeDetected: "eml", body: twoAttachmentEml });
    currentOrgId = orgId;

    // The one deliberate, narrow deviation from this file's real-substrate
    // convention: everything about the transaction/rollback behavior below
    // is real Postgres, exercised end-to-end — only the TRIGGER for the
    // second attachment's failure is synthetic, since there's no clean,
    // real-substrate way to force an S3/SQS failure for exactly the Nth
    // call without contriving global state that would affect other tests.
    // Restored immediately after use.
    let sendCount = 0;
    const realSend = sqsClient.send.bind(sqsClient);
    const sendSpy = vi.spyOn(sqsClient, "send").mockImplementation(async (...args: Parameters<typeof sqsClient.send>) => {
      sendCount++;
      if (sendCount === 2) throw new Error("Simulated SQS failure for the second attachment");
      return realSend(...args);
    });

    try {
      await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    } finally {
      sendSpy.mockRestore();
    }

    const parent = await getDocument(orgId, documentId);
    expect(parent.ingest_status).toBe("ready");

    const children = await withOrgSession(orgId, (client) =>
      client.query("SELECT original_filename, s3_key FROM documents WHERE parent_document_id = $1", [documentId]),
    );
    // Exactly one child exists — the first attachment's own INSERT+upload+
    // enqueue all committed together as a real unit; the second attempt's
    // INSERT was rolled back by its own transaction when the enqueue step
    // threw, not left behind as a dangling 'pending' row with no bytes and
    // no ingest_error (the exact "stuck on pending" symptom this fixes).
    expect(children.rows).toHaveLength(1);
    expect(children.rows[0].original_filename).toBe("exhibit-1.txt");
    const bytes = await readS3ObjectBytes(children.rows[0].s3_key);
    expect(bytes.toString("utf-8")).toBe("first exhibit");
  });

  it("marks a genuinely unsupported content type ('other') ready with no extraction attempted", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "drawing.dwg",
      contentTypeDetected: "other",
      body: Buffer.from("no reader exists for this format at all"),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.title).toBeNull();
    expect(doc.metadata).toBeNull();
  });

  it("extracts a pdf's real embedded text layer directly, with no OCR hand-off", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "bundle.pdf",
      contentTypeDetected: "pdf",
      body: PDF_WITH_TEXT_LAYER,
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("ready");
    expect(doc.metadata).toEqual({ text: "Real embedded text" });
  });

  it("hands a text-layer-less pdf (a stand-in for a scanned page) off to the ocr queue instead of marking it ready", async () => {
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-ocr-test" }));
    const ocrQueueUrl = process.env.EDD_WORKBENCH_OCR_QUEUE_URL!;
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: ocrQueueUrl })).catch(() => {});

    const { orgId, documentId } = await setupDocument({
      filename: "scanned-bundle.pdf",
      contentTypeDetected: "pdf",
      body: PDF_WITHOUT_TEXT_LAYER,
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    // Not 'ready' (nothing was actually extracted yet) and not 'failed'
    // (this isn't an error) — 'processing' until the ocr-service's own
    // handler resolves it one way or the other.
    expect(doc.ingest_status).toBe("processing");
    expect(doc.metadata).toBeNull();

    const { Messages } = await sqsClient.send(
      new ReceiveMessageCommand({ QueueUrl: ocrQueueUrl, WaitTimeSeconds: 2, MaxNumberOfMessages: 1 }),
    );
    expect(Messages).toHaveLength(1);
    expect(JSON.parse(Messages![0].Body!)).toEqual({ documentId, orgId });
  });

  it("hands an image off to the ocr queue directly — never attempts pdf text-layer extraction on it", async () => {
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-ocr-test" }));
    const ocrQueueUrl = process.env.EDD_WORKBENCH_OCR_QUEUE_URL!;
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: ocrQueueUrl })).catch(() => {});

    const { orgId, documentId } = await setupDocument({
      filename: "scan.png",
      contentTypeDetected: "image",
      body: Buffer.from("not a real png — pdf text-layer extraction is never attempted on an image, so this never gets parsed as one"),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("processing");

    const { Messages } = await sqsClient.send(
      new ReceiveMessageCommand({ QueueUrl: ocrQueueUrl, WaitTimeSeconds: 2, MaxNumberOfMessages: 1 }),
    );
    expect(Messages).toHaveLength(1);
    expect(JSON.parse(Messages![0].Body!)).toEqual({ documentId, orgId });
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
        "SELECT id, guid_number, content_type_detected, ingest_status, parent_document_id, family_document_id, depth, s3_key, size_bytes, subject, metadata FROM documents WHERE matter_id = $1 AND metadata->>'source' = 'pst' ORDER BY guid_number",
        [matterId],
      ),
    );
    expect(children.rows).toHaveLength(9);
    for (const child of children.rows) {
      expect(child.content_type_detected).toBe("eml");
      expect(child.ingest_status).toBe("ready");
      expect(child.s3_key).toBeNull();
      // The real PR_MESSAGE_SIZE property (see pst.ts's sizeBytes/
      // ingest.ts's handlePstIngest) — not the hardcoded 0 this used to be,
      // the exact "email sizes are not being populated" gap reported for
      // PST-derived messages specifically.
      expect(Number(child.size_bytes)).toBeGreaterThan(0);
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

  it("keeps a PST's own row (and real S3 object) at the depth cap, without ever opening the file — PST checks the cap itself before downloading, a different code path from zip/7z/mbox's shared one, so it needs its own proof", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "deep.ost",
      contentTypeDetected: "pst",
      body: FIXTURE_MTNMAN_OST,
    });
    currentOrgId = orgId;
    await withOrgSession(orgId, (client) => client.query("UPDATE documents SET depth = 5 WHERE id = $1", [documentId]));
    const s3Key = (await getDocument(orgId, documentId)).s3_key;

    await handleIngestMessage(JSON.stringify({ documentId, orgId }));

    const doc = await getDocument(orgId, documentId);
    expect(doc).not.toBeUndefined();
    expect(doc.ingest_status).toBe("ready");
    expect(doc.metadata).toEqual({ depthCapped: true });

    const children = await withOrgSession(orgId, (client) =>
      client.query("SELECT id FROM documents WHERE parent_document_id = $1", [documentId]),
    );
    expect(children.rows).toHaveLength(0);
    await expect(s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key }))).resolves.toBeTruthy();
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

  it("keeps a transparent container's own row (and real S3 object) instead of deleting it, when the container itself arrives at the depth cap — previously zip/7z/pst/mbox had no depth cap at all, unlike email attachments, an inconsistency now fixed uniformly for every container type", async () => {
    const zip = new JSZip();
    zip.file("exhibit-1.txt", "should never be extracted — the cap must stop expansion before this is even looked at");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const { orgId, documentId } = await setupDocument({ filename: "deep.zip", contentTypeDetected: "zip", body: buffer });
    currentOrgId = orgId;
    // Simulates arriving via 5 real levels of nesting (matches this file's
    // own "simulate arriving nested" pattern elsewhere, just pushed to the
    // MAX_CONTAINER_EXPANSION_DEPTH boundary instead of a realistic depth 1).
    await withOrgSession(orgId, (client) => client.query("UPDATE documents SET depth = 5 WHERE id = $1", [documentId]));
    const s3Key = (await getDocument(orgId, documentId)).s3_key;

    await handleIngestMessage(JSON.stringify({ documentId, orgId }));

    // Kept, not deleted — "capped, didn't even look" is not the same
    // outcome as "looked, found nothing left to review", which is the
    // only case that deletes a transparent container's own row.
    const doc = await getDocument(orgId, documentId);
    expect(doc).not.toBeUndefined();
    expect(doc.ingest_status).toBe("ready");
    expect(doc.metadata).toEqual({ depthCapped: true });

    const children = await withOrgSession(orgId, (client) =>
      client.query("SELECT id FROM documents WHERE parent_document_id = $1", [documentId]),
    );
    expect(children.rows).toHaveLength(0);

    // The real S3 object is untouched too — not silently discarded.
    await expect(s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key }))).resolves.toBeTruthy();
  });

  it("transparently expands a real 7z: the archive's own row/S3 object disappear, each member becomes its own independent top-level document, fully re-processed", async () => {
    const buffer = await buildFixtureSevenZip({
      "exhibit-1.txt": "plain text exhibit",
      "docs/witness-statement.eml": FIXTURE_EML,
    });

    const { orgId, documentId } = await setupDocument({ filename: "production-set.7z", contentTypeDetected: "7z", body: buffer });
    currentOrgId = orgId;
    const matterIdRow = await withOrgSession(orgId, (client) =>
      client.query<{ matter_id: string; s3_key: string }>("SELECT matter_id, s3_key FROM documents WHERE id = $1", [documentId]),
    );
    const { matter_id: matterId, s3_key: archiveS3Key } = matterIdRow.rows[0];

    await handleIngestMessage(JSON.stringify({ documentId, orgId }));

    expect(await getDocument(orgId, documentId)).toBeUndefined();
    await expect(s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: archiveS3Key }))).rejects.toBeTruthy();

    const members = await withOrgSession(orgId, (client) =>
      client.query(
        "SELECT id, original_filename, content_type_detected, parent_document_id, family_document_id, depth, s3_key, metadata FROM documents WHERE matter_id = $1 AND metadata->>'source' = '7z' ORDER BY guid_number",
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
      expect(member.parent_document_id).toBeNull();
      expect(member.family_document_id).toBe(member.id);
      expect(member.depth).toBe(0);
    }

    const textBytes = await readS3ObjectBytes(textMember.s3_key);
    expect(textBytes.toString("utf-8")).toBe("plain text exhibit");

    await handleIngestMessage(JSON.stringify({ documentId: emlMember.id, orgId }));
    const processedEmlMember = await getDocument(orgId, emlMember.id);
    expect(processedEmlMember.ingest_status).toBe("ready");
    expect(processedEmlMember.subject).toBe("Draft witness statement");
  });

  it("a 7z arriving nested (as if it were an email's own attachment) passes its members through to the EMAIL's family, not a fresh independent one", async () => {
    const buffer = await buildFixtureSevenZip({ "exhibit-1.txt": "nested-7z member" });

    const { orgId, documentId: emailId } = await setupDocument({ filename: "covering-email.eml", contentTypeDetected: "eml", body: null });
    currentOrgId = orgId;
    const matterIdRow = await withOrgSession(orgId, (client) =>
      client.query<{ matter_id: string }>("SELECT matter_id FROM documents WHERE id = $1", [emailId]),
    );
    const matterId = matterIdRow.rows[0].matter_id;

    const archiveDocumentId = await withOrgSession(orgId, async (client) => {
      await ensureBucket();
      const guidNumber = await nextMatterGuid(client, matterId);
      const archiveDocumentId = randomUUID();
      const s3Key = `tenants/test/documents/${archiveDocumentId}/original.7z`;
      await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: buffer }));
      await client.query(
        `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'exhibits.7z', '7z', $8, $9, '7z', 'pending')`,
        [archiveDocumentId, orgId, matterId, emailId, emailId, 1, guidNumber, buffer.byteLength, s3Key],
      );
      return archiveDocumentId;
    });

    await handleIngestMessage(JSON.stringify({ documentId: archiveDocumentId, orgId }));

    expect(await getDocument(orgId, archiveDocumentId)).toBeUndefined();

    const members = await withOrgSession(orgId, (client) =>
      client.query<{ parent_document_id: string; family_document_id: string; depth: number }>(
        "SELECT parent_document_id, family_document_id, depth FROM documents WHERE matter_id = $1 AND metadata->>'source' = '7z'",
        [matterId],
      ),
    );
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].parent_document_id).toBe(emailId);
    expect(members.rows[0].family_document_id).toBe(emailId);
    expect(members.rows[0].depth).toBe(1);
  });

  it("marks a corrupt 7z failed, with a recorded error, and creates no member documents at all", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "corrupt.7z",
      contentTypeDetected: "7z",
      body: Buffer.from("not a real 7z file at all, just garbage bytes for this test"),
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

  it("fails cleanly with a recorded ingest_error, without ever attempting the S3 download, when a 7z's size_bytes exceeds the pre-flight compressed-size ceiling", async () => {
    const oversizedBytes = 11 * 1024 ** 3; // just over SEVEN_ZIP_MAX_SIZE_BYTES's 10 GiB ceiling
    const { orgId, documentId } = await setupDocument({
      filename: "huge.7z",
      contentTypeDetected: "7z",
      body: null,
      sizeBytesOverride: oversizedBytes,
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("failed");
    expect(doc.ingest_error).toContain(String(oversizedBytes));
  });

  it("transparently expands a real mbox: the mailbox's own row/S3 object disappear, each message becomes its own independent top-level 'eml' document, fully re-processed", async () => {
    const message1 = Buffer.concat([Buffer.from("From jane@example.com Mon Jan 12 09:30:00 2026\n"), FIXTURE_EML]);
    const message2 = buildEmlWithRfc822Attachment("Second message in the mailbox.", "irrelevant.eml", FIXTURE_EML);
    const mboxBuffer = Buffer.concat([message1, Buffer.from("\nFrom john@example.com Mon Jan 12 10:00:00 2026\n"), message2]);

    const { orgId, documentId } = await setupDocument({ filename: "mailbox.mbox", contentTypeDetected: "mbox", body: mboxBuffer });
    currentOrgId = orgId;
    const matterIdRow = await withOrgSession(orgId, (client) =>
      client.query<{ matter_id: string; s3_key: string }>("SELECT matter_id, s3_key FROM documents WHERE id = $1", [documentId]),
    );
    const { matter_id: matterId, s3_key: mboxS3Key } = matterIdRow.rows[0];

    await handleIngestMessage(JSON.stringify({ documentId, orgId }));

    expect(await getDocument(orgId, documentId)).toBeUndefined();
    await expect(s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: mboxS3Key }))).rejects.toBeTruthy();

    const members = await withOrgSession(orgId, (client) =>
      client.query(
        "SELECT id, original_filename, content_type_detected, ingest_status, parent_document_id, family_document_id, depth, s3_key, metadata FROM documents WHERE matter_id = $1 AND metadata->>'source' = 'mbox' ORDER BY guid_number",
        [matterId],
      ),
    );
    expect(members.rows).toHaveLength(2);
    for (const member of members.rows) {
      // Every mbox member is hardcoded to 'eml' — a raw split mbox message
      // IS a complete real RFC822 message already, re-entering the
      // handler's own eml branch via the queue with zero duplicated
      // parsing logic.
      expect(member.original_filename).toBe(`message-${member.metadata.mboxIndex}.eml`);
      expect(member.content_type_detected).toBe("eml");
      expect(member.ingest_status).toBe("pending");
      expect(member.s3_key).toBeTruthy();
      expect(member.parent_document_id).toBeNull();
      expect(member.family_document_id).toBe(member.id);
      expect(member.depth).toBe(0);
    }

    // Each message gets fully re-processed by re-entering the SAME eml
    // branch via the queue — real subject extraction proves it, not just
    // "some bytes got copied somewhere." Looked up by the id captured
    // above, not by re-querying metadata->>'source' — the eml branch's own
    // UPDATE replaces metadata wholesale with its own extracted fields,
    // so the 'mbox' source marker is gone once a member is reprocessed
    // (matches the zip/7z tests' own identical "look up by id after
    // reprocessing" pattern, for the same reason).
    for (const member of members.rows) {
      await handleIngestMessage(JSON.stringify({ documentId: member.id, orgId }));
    }
    const processed = await Promise.all(members.rows.map((member) => getDocument(orgId, member.id)));
    expect(processed.every((r) => r.ingest_status === "ready")).toBe(true);
    expect(processed.map((r) => r.subject)).toContain("Draft witness statement");
  });

  it("an mbox arriving nested (as if it were an email's own attachment) passes its messages through to the EMAIL's family, not a fresh independent one", async () => {
    const mboxBuffer = Buffer.concat([Buffer.from("From jane@example.com Mon Jan 12 09:30:00 2026\n"), FIXTURE_EML]);

    const { orgId, documentId: emailId } = await setupDocument({ filename: "covering-email.eml", contentTypeDetected: "eml", body: null });
    currentOrgId = orgId;
    const matterIdRow = await withOrgSession(orgId, (client) =>
      client.query<{ matter_id: string }>("SELECT matter_id FROM documents WHERE id = $1", [emailId]),
    );
    const matterId = matterIdRow.rows[0].matter_id;

    const mboxDocumentId = await withOrgSession(orgId, async (client) => {
      await ensureBucket();
      const guidNumber = await nextMatterGuid(client, matterId);
      const mboxDocumentId = randomUUID();
      const s3Key = `tenants/test/documents/${mboxDocumentId}/original.mbox`;
      await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: mboxBuffer }));
      await client.query(
        `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'mailbox.mbox', 'mbox', $8, $9, 'mbox', 'pending')`,
        [mboxDocumentId, orgId, matterId, emailId, emailId, 1, guidNumber, mboxBuffer.byteLength, s3Key],
      );
      return mboxDocumentId;
    });

    await handleIngestMessage(JSON.stringify({ documentId: mboxDocumentId, orgId }));

    expect(await getDocument(orgId, mboxDocumentId)).toBeUndefined();

    const members = await withOrgSession(orgId, (client) =>
      client.query<{ parent_document_id: string; family_document_id: string; depth: number }>(
        "SELECT parent_document_id, family_document_id, depth FROM documents WHERE matter_id = $1 AND metadata->>'source' = 'mbox'",
        [matterId],
      ),
    );
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].parent_document_id).toBe(emailId);
    expect(members.rows[0].family_document_id).toBe(emailId);
    expect(members.rows[0].depth).toBe(1);
  });

  it("an mbox with no real 'From ' message boundary at all transparently vanishes with zero members — same 'empty container, nothing to review' precedent already accepted for a contentless zip/PST", async () => {
    const { orgId, documentId } = await setupDocument({
      filename: "not-really-a-mailbox.mbox",
      contentTypeDetected: "mbox",
      body: Buffer.from("just some plain text with no real mbox boundary line at all"),
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));

    // Transparent even with zero real content — mbox has no magic-byte
    // format to violate the way zip/7z/pst do, so there's no honest
    // "corrupt mbox" failure mode; this is the real, correct behavior to
    // lock in instead.
    expect(await getDocument(orgId, documentId)).toBeUndefined();
  });

  it("fails cleanly with a recorded ingest_error, without ever attempting the S3 download, when an mbox's size_bytes exceeds the pre-flight ceiling", async () => {
    const oversizedBytes = 81 * 1024 ** 3; // just over MBOX_MAX_SIZE_BYTES's 80 GiB ceiling
    const { orgId, documentId } = await setupDocument({
      filename: "huge.mbox",
      contentTypeDetected: "mbox",
      body: null,
      sizeBytesOverride: oversizedBytes,
    });
    currentOrgId = orgId;
    await handleIngestMessage(JSON.stringify({ documentId, orgId }));
    const doc = await getDocument(orgId, documentId);

    expect(doc.ingest_status).toBe("failed");
    expect(doc.ingest_error).toContain(String(oversizedBytes));
  });

  it("recurses through a real nested zip → 7z → mbox → eml chain, arriving off a real covering email, all sharing that email's own family with strictly increasing depth once a real node (the final eml's own attachment) is reached", async () => {
    // Innermost real leaf: an eml with its own real attachment.
    const leafEmlWithAttachment = Buffer.from(
      [
        'From: "Jane Reviewer" <jane@example.com>',
        'To: "John Admin" <john@example.com>',
        "Subject: Final exhibit in the chain",
        "Date: Mon, 12 Jan 2026 09:30:00 +0000",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="LEAF-BOUNDARY"',
        "",
        "--LEAF-BOUNDARY",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "See the final exhibit attached.",
        "",
        "--LEAF-BOUNDARY",
        'Content-Type: text/plain; name="final-exhibit.txt"',
        'Content-Disposition: attachment; filename="final-exhibit.txt"',
        "",
        "final exhibit content",
        "--LEAF-BOUNDARY--",
        "",
      ].join("\r\n"),
      "utf-8",
    );
    const mboxBuffer = Buffer.concat([Buffer.from("From leaf@example.com Mon Jan 12 09:30:00 2026\n"), leafEmlWithAttachment]);
    const sevenZipBuffer = await buildFixtureSevenZip({ "mailbox.mbox": mboxBuffer });
    const zip = new JSZip();
    zip.file("archive.7z", sevenZipBuffer);
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    // The zip arrives NESTED — a real attachment of a real covering email —
    // rather than a fresh top-level upload. This is the deliberate choice
    // that makes every container below inherit the SAME shared family
    // rather than each one minting its own fresh independent root (which
    // is what would happen if this chain were uploaded top-level instead —
    // already covered by this file's own single-level "transparently
    // expands" tests for each container type).
    const { orgId, documentId: coveringEmailId } = await setupDocument({
      filename: "covering-email.eml",
      contentTypeDetected: "eml",
      body: null,
    });
    currentOrgId = orgId;
    const matterIdRow = await withOrgSession(orgId, (client) =>
      client.query<{ matter_id: string }>("SELECT matter_id FROM documents WHERE id = $1", [coveringEmailId]),
    );
    const matterId = matterIdRow.rows[0].matter_id;

    const zipDocumentId = await withOrgSession(orgId, async (client) => {
      await ensureBucket();
      const guidNumber = await nextMatterGuid(client, matterId);
      const zipDocumentId = randomUUID();
      const s3Key = `tenants/test/documents/${zipDocumentId}/original.zip`;
      await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: zipBuffer }));
      await client.query(
        `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'exhibits.zip', 'zip', $8, $9, 'zip', 'pending')`,
        [zipDocumentId, orgId, matterId, coveringEmailId, coveringEmailId, 1, guidNumber, zipBuffer.byteLength, s3Key],
      );
      return zipDocumentId;
    });

    // Step 1: zip -> 7z member (transparent pass-through: same depth/family
    // the zip itself occupied, inherited from the covering email).
    await handleIngestMessage(JSON.stringify({ documentId: zipDocumentId, orgId }));
    const sevenZipMember = await withOrgSession(orgId, (client) =>
      client.query("SELECT * FROM documents WHERE parent_document_id = $1 AND metadata->>'source' = 'zip'", [coveringEmailId]),
    );
    expect(sevenZipMember.rows).toHaveLength(1);
    expect(sevenZipMember.rows[0].content_type_detected).toBe("7z");
    expect(sevenZipMember.rows[0].family_document_id).toBe(coveringEmailId);
    expect(sevenZipMember.rows[0].depth).toBe(1);

    // Step 2: 7z -> mbox member (same pass-through again).
    await handleIngestMessage(JSON.stringify({ documentId: sevenZipMember.rows[0].id, orgId }));
    const mboxMember = await withOrgSession(orgId, (client) =>
      client.query("SELECT * FROM documents WHERE parent_document_id = $1 AND metadata->>'source' = '7z'", [coveringEmailId]),
    );
    expect(mboxMember.rows).toHaveLength(1);
    expect(mboxMember.rows[0].content_type_detected).toBe("mbox");
    expect(mboxMember.rows[0].family_document_id).toBe(coveringEmailId);
    expect(mboxMember.rows[0].depth).toBe(1);

    // Step 3: mbox -> the real eml message (same pass-through again — mbox
    // members are hardcoded 'eml', re-entering the ordinary eml branch).
    await handleIngestMessage(JSON.stringify({ documentId: mboxMember.rows[0].id, orgId }));
    const emlMessage = await withOrgSession(orgId, (client) =>
      client.query("SELECT * FROM documents WHERE parent_document_id = $1 AND metadata->>'source' = 'mbox'", [coveringEmailId]),
    );
    expect(emlMessage.rows).toHaveLength(1);
    expect(emlMessage.rows[0].content_type_detected).toBe("eml");
    expect(emlMessage.rows[0].family_document_id).toBe(coveringEmailId);
    expect(emlMessage.rows[0].depth).toBe(1);
    expect(emlMessage.rows[0].ingest_status).toBe("pending");

    // Step 4: the eml message IS a real node (not transparent) — processing
    // it extracts its own real metadata AND expands its own real
    // attachment one level deeper, via the ordinary expandAttachments path.
    await handleIngestMessage(JSON.stringify({ documentId: emlMessage.rows[0].id, orgId }));
    const processedEmlMessage = await getDocument(orgId, emlMessage.rows[0].id);
    expect(processedEmlMessage.ingest_status).toBe("ready");
    expect(processedEmlMessage.subject).toBe("Final exhibit in the chain");

    const finalAttachment = await withOrgSession(orgId, (client) =>
      client.query("SELECT * FROM documents WHERE parent_document_id = $1", [emlMessage.rows[0].id]),
    );
    expect(finalAttachment.rows).toHaveLength(1);
    expect(finalAttachment.rows[0].original_filename).toBe("final-exhibit.txt");
    // The one point in this whole chain where depth actually increments —
    // every container above was transparent (same depth, same family);
    // this is a REAL node's REAL child, exactly like any other attachment.
    expect(finalAttachment.rows[0].depth).toBe(2);
    expect(finalAttachment.rows[0].family_document_id).toBe(coveringEmailId);

    const finalBytes = await readS3ObjectBytes(finalAttachment.rows[0].s3_key);
    expect(finalBytes.toString("utf-8")).toBe("final exhibit content");
  });
});
