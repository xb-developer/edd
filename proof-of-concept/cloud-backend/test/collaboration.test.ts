import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, withTenantContext } from "../src/db/pool.js";
import { uploadDocument } from "../src/documents/uploadDocument.js";
import { drainJobs } from "./helpers.js";

const admin = { organizationId: null, userId: null, isPlatformAdmin: true } as const;

interface Seeded {
  orgA: string;
  groupA1: string;
  userA1a: string; // uploads the document and creates the tag
  userA1b: string; // same group, different person — should see everything A1a did
  userA2: string; // same org, NOT in groupA1 — the negative control
  matterA1: string;
}

let seeded: Seeded;

before(async () => {
  const base = await withTenantContext(admin, async (client) => {
    const org = async (name: string) => {
      const { rows } = await client.query(
        "INSERT INTO organizations (auth0_org_id, name) VALUES ($1, $2) RETURNING id",
        [`auth0|collab-org-${name}-${Date.now()}-${Math.random()}`, `Collab Org ${name}`],
      );
      return rows[0].id as string;
    };
    const user = async (orgId: string, email: string) => {
      const { rows } = await client.query(
        "INSERT INTO users (auth0_user_id, organization_id, email) VALUES ($1, $2, $3) RETURNING id",
        [`auth0|collab-user-${email}-${Date.now()}-${Math.random()}`, orgId, email],
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
    const groupA1 = await group(orgA, "Collab Team A1");
    const userA1a = await user(orgA, "collab-a1a@example.com");
    const userA1b = await user(orgA, "collab-a1b@example.com");
    const userA2 = await user(orgA, "collab-a2@example.com");
    await client.query("INSERT INTO group_members (group_id, user_id, organization_id) VALUES ($1, $2, $3)", [
      groupA1,
      userA1a,
      orgA,
    ]);
    await client.query("INSERT INTO group_members (group_id, user_id, organization_id) VALUES ($1, $2, $3)", [
      groupA1,
      userA1b,
      orgA,
    ]);
    // userA2 is deliberately NOT added to groupA1.

    return { orgA, groupA1, userA1a, userA1b, userA2 };
  });

  const matterA1 = await withTenantContext(
    { organizationId: base.orgA, userId: base.userA1a, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query(
        "INSERT INTO matters (organization_id, group_id, created_by_user_id, name) VALUES ($1, $2, $3, $4) RETURNING id",
        [base.orgA, base.groupA1, base.userA1a, "Collab Matter A1"],
      );
      return rows[0].id as string;
    },
  );

  seeded = { ...base, matterA1 };
});

after(async () => {
  await pool.end();
});

test("a group member sees a document, its tags, and its content via search — none of which they created", async () => {
  const uploaderTenant = { organizationId: seeded.orgA, userId: seeded.userA1a, isPlatformAdmin: false };
  const colleagueTenant = { organizationId: seeded.orgA, userId: seeded.userA1b, isPlatformAdmin: false };
  const outsiderTenant = { organizationId: seeded.orgA, userId: seeded.userA2, isPlatformAdmin: false };

  // userA1a uploads a document with distinctive, searchable content.
  const document = await uploadDocument(uploaderTenant, seeded.matterA1, {
    originalname: "settlement-terms.txt",
    mimetype: "text/plain",
    size: 0,
    buffer: Buffer.from("The parties agree to a confidential zorblatt settlement arrangement."),
  });
  await drainJobs();

  // userA1a creates and applies a tag.
  const tag = await withTenantContext(uploaderTenant, async (client) => {
    const { rows } = await client.query(
      "INSERT INTO tags (organization_id, name, color, created_by_user_id) VALUES ($1, $2, $3, $4) RETURNING id, name",
      [seeded.orgA, "Hot Document", "#ff0000", seeded.userA1a],
    );
    return rows[0];
  });
  await withTenantContext(uploaderTenant, async (client) => {
    await client.query(
      "INSERT INTO document_tags (document_id, tag_id, organization_id, group_id, applied_by_user_id) VALUES ($1, $2, $3, $4, $5)",
      [document.id, tag.id, seeded.orgA, seeded.groupA1, seeded.userA1a],
    );
  });

  // --- userA1b (colleague, same group, uploaded nothing) should see all of it ---
  const colleagueView = await withTenantContext(colleagueTenant, async (client) => {
    const doc = await client.query("SELECT id, status FROM documents WHERE id = $1", [document.id]);
    const tags = await client.query(
      `SELECT t.name FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = $1`,
      [document.id],
    );
    const search = await client.query(
      "SELECT id FROM documents WHERE matter_id = $1 AND search_vector @@ websearch_to_tsquery('english', $2)",
      [seeded.matterA1, "zorblatt"],
    );
    return { doc: doc.rows[0], tagNames: tags.rows.map((r) => r.name), searchHits: search.rows.map((r) => r.id) };
  });

  assert.equal(colleagueView.doc?.status, "extracted", "colleague should see the document, fully extracted");
  assert.deepEqual(colleagueView.tagNames, ["Hot Document"], "colleague should see the tag someone else applied");
  assert.deepEqual(colleagueView.searchHits, [document.id], "colleague should find the document via full-text search");

  // --- userA2 (same org, NOT in the group) should see none of it — the negative control ---
  const outsiderView = await withTenantContext(outsiderTenant, async (client) => {
    const doc = await client.query("SELECT id FROM documents WHERE id = $1", [document.id]);
    const tags = await client.query("SELECT tag_id FROM document_tags WHERE document_id = $1", [document.id]);
    const search = await client.query(
      "SELECT id FROM documents WHERE matter_id = $1 AND search_vector @@ websearch_to_tsquery('english', $2)",
      [seeded.matterA1, "zorblatt"],
    );
    return { docRows: doc.rows, tagRows: tags.rows, searchHits: search.rows };
  });

  assert.equal(outsiderView.docRows.length, 0, "org-mate outside the group must not see the document");
  assert.equal(outsiderView.tagRows.length, 0, "org-mate outside the group must not see the tag application");
  assert.equal(outsiderView.searchHits.length, 0, "org-mate outside the group must not find it via search");

  // The tag DEFINITION itself is org-wide vocabulary, unlike its application —
  // userA2 should see it exists in the shared tag list even though they can't
  // see it applied to this particular document.
  const outsiderTagList = await withTenantContext(outsiderTenant, async (client) => {
    const { rows } = await client.query("SELECT name FROM tags WHERE organization_id = $1", [seeded.orgA]);
    return rows.map((r) => r.name);
  });
  assert.ok(outsiderTagList.includes("Hot Document"), "tag vocabulary itself is org-wide, not group-gated");
});
