import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pool, withTenantContext } from "../src/db/pool.js";
import { uploadDocument } from "../src/documents/uploadDocument.js";
import { drainJobs } from "./helpers.js";

const admin = { organizationId: null, userId: null, isPlatformAdmin: true } as const;

interface Seeded {
  orgA: string;
  userA1: string;
  groupA1: string;
  matterA1: string;
  orgB: string;
  userB1: string;
}

let seeded: Seeded;

before(async () => {
  const base = await withTenantContext(admin, async (client) => {
    const org = async (name: string) => {
      const { rows } = await client.query(
        "INSERT INTO organizations (auth0_org_id, name) VALUES ($1, $2) RETURNING id",
        [`auth0|pipeline-org-${name}-${Date.now()}-${Math.random()}`, `Pipeline Org ${name}`],
      );
      return rows[0].id as string;
    };
    const user = async (orgId: string, email: string) => {
      const { rows } = await client.query(
        "INSERT INTO users (auth0_user_id, organization_id, email) VALUES ($1, $2, $3) RETURNING id",
        [`auth0|pipeline-user-${email}-${Date.now()}-${Math.random()}`, orgId, email],
      );
      return rows[0].id as string;
    };
    const group = async (orgId: string, name: string) => {
      const { rows } = await client.query(
        "INSERT INTO groups (organization_id, name) VALUES ($1, $2) RETURNING id",
        [orgId, name],
      );
      return rows[0].id as string;
    };

    const orgA = await org("A");
    const orgB = await org("B");
    const userA1 = await user(orgA, "pipeline-a1@example.com");
    const userB1 = await user(orgB, "pipeline-b1@example.com");
    const groupA1 = await group(orgA, "Pipeline Team A1");
    await client.query("INSERT INTO group_members (group_id, user_id, organization_id) VALUES ($1, $2, $3)", [
      groupA1,
      userA1,
      orgA,
    ]);

    return { orgA, orgB, userA1, userB1, groupA1 };
  });

  const matterA1 = await withTenantContext(
    { organizationId: base.orgA, userId: base.userA1, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query(
        "INSERT INTO matters (organization_id, group_id, created_by_user_id, name) VALUES ($1, $2, $3, $4) RETURNING id",
        [base.orgA, base.groupA1, base.userA1, "Pipeline Matter A1"],
      );
      return rows[0].id as string;
    },
  );

  seeded = { ...base, matterA1 };
});

after(async () => {
  await pool.end();
});

test("uploading a .txt file flows end to end: stored, queued, extracted, correct text", async () => {
  const tenant = { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false };
  const content = "The quick brown fox jumps over the lazy dog.";

  const document = await uploadDocument(tenant, seeded.matterA1, {
    originalname: "note.txt",
    mimetype: "text/plain",
    size: Buffer.byteLength(content),
    buffer: Buffer.from(content, "utf8"),
  });

  assert.equal(document.status, "pending_extraction");
  assert.equal(document.guid, "000001", "first document in this matter should get GUID 000001");

  await drainJobs();

  const row = await withTenantContext(tenant, async (client) => {
    const { rows } = await client.query("SELECT status, extracted_text FROM documents WHERE id = $1", [document.id]);
    return rows[0];
  });
  assert.equal(row.status, "extracted");
  assert.equal(row.extracted_text, content);
});

test("uploading a real PDF flows end to end and its text is genuinely extracted (not just stubbed)", async () => {
  const tenant = { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false };

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([300, 150]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText("Deployment Strategy Pilot Document", { x: 20, y: 100, size: 16, font });
  const pdfBytes = await pdfDoc.save();

  const document = await uploadDocument(tenant, seeded.matterA1, {
    originalname: "pilot.pdf",
    mimetype: "application/pdf",
    size: pdfBytes.byteLength,
    buffer: Buffer.from(pdfBytes),
  });

  await drainJobs();

  const row = await withTenantContext(tenant, async (client) => {
    const { rows } = await client.query("SELECT status, extracted_text FROM documents WHERE id = $1", [document.id]);
    return rows[0];
  });
  assert.equal(row.status, "extracted");
  assert.match(row.extracted_text, /Deployment Strategy Pilot Document/);
});

test("an unsupported format fails extraction visibly instead of hanging as pending forever", async () => {
  const tenant = { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false };

  const document = await uploadDocument(tenant, seeded.matterA1, {
    originalname: "mystery.xyz",
    mimetype: "application/octet-stream",
    size: 4,
    buffer: Buffer.from("data"),
  });

  await drainJobs();

  const row = await withTenantContext(tenant, async (client) => {
    const { rows } = await client.query("SELECT status, extraction_error FROM documents WHERE id = $1", [document.id]);
    return rows[0];
  });
  assert.equal(row.status, "extraction_failed");
  assert.match(row.extraction_error, /unsupported format/);
});

test("a second organization's user cannot see the first organization's uploaded document", async () => {
  const tenant = { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false };
  const document = await uploadDocument(tenant, seeded.matterA1, {
    originalname: "confidential.txt",
    mimetype: "text/plain",
    size: 4,
    buffer: Buffer.from("data"),
  });

  const rows = await withTenantContext(
    { organizationId: seeded.orgB, userId: seeded.userB1, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query("SELECT id FROM documents WHERE id = $1", [document.id]);
      return rows;
    },
  );
  assert.equal(rows.length, 0, "org B must not be able to read org A's document row");
});

test("uploading to a matter the caller has no access to is rejected, not silently allocated a GUID", async () => {
  await assert.rejects(
    uploadDocument({ organizationId: seeded.orgB, userId: seeded.userB1, isPlatformAdmin: false }, seeded.matterA1, {
      originalname: "should-not-work.txt",
      mimetype: "text/plain",
      size: 4,
      buffer: Buffer.from("data"),
    }),
    /not_found_or_no_access/,
  );
});
