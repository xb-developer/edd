import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool, withOrgSession, initMatterGuidCounter, nextMatterGuid } from "@xbundle/edd-workbench-core";
import { documentTagsRouter } from "./documentTags.js";
import { documentsRouter } from "./documents.js";
import type { EddRequestContext } from "../auth.js";

function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/matters/:matterId/document-tags", documentTagsRouter);
  app.use("/api/matters/:matterId/documents", documentsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (typeof status === "number") {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
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

async function createTestTag(orgId: string, matterId: string, name: string): Promise<string> {
  return withOrgSession(orgId, async (client) => {
    const set = await client.query<{ id: string }>(
      "INSERT INTO tag_sets (org_id, matter_id, name, position) VALUES ($1, $2, $3, 0) RETURNING id",
      [orgId, matterId, `${name} set`],
    );
    const tag = await client.query<{ id: string }>(
      "INSERT INTO tags (org_id, matter_id, tag_set_id, name, position) VALUES ($1, $2, $3, $4, 0) RETURNING id",
      [orgId, matterId, set.rows[0].id, name],
    );
    return tag.rows[0].id;
  });
}

async function createTestDocument(orgId: string, matterId: string, filename = "doc.txt"): Promise<string> {
  return withOrgSession(orgId, async (client) => {
    const guidNumber = await nextMatterGuid(client, matterId);
    const documentId = randomUUID();
    await client.query(
      `INSERT INTO documents (id, org_id, matter_id, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status, family_document_id, depth)
       VALUES ($1, $2, $3, $4, $5, 'txt', 10, $6, 'text', 'ready', $1, 0)`,
      [documentId, orgId, matterId, guidNumber, filename, `tenants/${orgId}/matters/${matterId}/documents/${documentId}/original.txt`],
    );
    return documentId;
  });
}

afterAll(async () => {
  await pool.end();
});

describe("documentTags router", () => {
  it("apply with a single documentId (the existing single-doc toggle case) tags exactly that document", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("dt-single");
    try {
      const tagId = await createTestTag(orgId, matterId, "Hot Doc");
      const docId = await createTestDocument(orgId, matterId);
      const app = buildTestApp({ orgId, userId, role: "reviewer", email: "tester@example.com" });

      const response = await request(app).post(`/api/matters/${matterId}/document-tags/apply`).send({ documentIds: [docId], tagId });
      expect(response.status).toBe(200);

      const tags = await request(app).get(`/api/matters/${matterId}/document-tags/${docId}`);
      expect(tags.body).toEqual([tagId]);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("apply with N documentIds in one call tags all of them (bulk case)", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("dt-bulk");
    try {
      const tagId = await createTestTag(orgId, matterId, "Responsive");
      const docIds = [await createTestDocument(orgId, matterId, "a.txt"), await createTestDocument(orgId, matterId, "b.txt"), await createTestDocument(orgId, matterId, "c.txt")];
      const app = buildTestApp({ orgId, userId, role: "reviewer", email: "tester@example.com" });

      const response = await request(app).post(`/api/matters/${matterId}/document-tags/apply`).send({ documentIds: docIds, tagId });
      expect(response.status).toBe(200);

      const bulk = await request(app).get(`/api/matters/${matterId}/document-tags`);
      for (const docId of docIds) {
        expect(bulk.body[docId]).toEqual([tagId]);
      }
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("applying an already-applied tag is idempotent (no duplicate row)", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("dt-idempotent");
    try {
      const tagId = await createTestTag(orgId, matterId, "Privileged");
      const docId = await createTestDocument(orgId, matterId);
      const app = buildTestApp({ orgId, userId, role: "reviewer", email: "tester@example.com" });

      await request(app).post(`/api/matters/${matterId}/document-tags/apply`).send({ documentIds: [docId], tagId });
      const second = await request(app).post(`/api/matters/${matterId}/document-tags/apply`).send({ documentIds: [docId], tagId });
      expect(second.status).toBe(200);

      const rows = await withOrgSession(orgId, (client) =>
        client.query("SELECT * FROM document_tags WHERE document_id = $1 AND tag_id = $2", [docId, tagId]),
      );
      expect(rows.rowCount).toBe(1);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("remove with N ids removes for all of them; removing an unapplied tag is a no-op", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("dt-remove");
    try {
      const tagId = await createTestTag(orgId, matterId, "Not Responsive");
      const docIds = [await createTestDocument(orgId, matterId, "a.txt"), await createTestDocument(orgId, matterId, "b.txt")];
      const app = buildTestApp({ orgId, userId, role: "reviewer", email: "tester@example.com" });

      await request(app).post(`/api/matters/${matterId}/document-tags/apply`).send({ documentIds: docIds, tagId });
      const remove = await request(app).post(`/api/matters/${matterId}/document-tags/remove`).send({ documentIds: docIds, tagId });
      expect(remove.status).toBe(200);

      const bulk = await request(app).get(`/api/matters/${matterId}/document-tags`);
      expect(bulk.body[docIds[0]]).toBeUndefined();

      // Removing again (nothing applied) must not error.
      const removeAgain = await request(app).post(`/api/matters/${matterId}/document-tags/remove`).send({ documentIds: docIds, tagId });
      expect(removeAgain.status).toBe(200);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("applying a tagId that doesn't belong to this matter returns 404 and writes nothing", async () => {
    const { orgId, matterId: matterA, userId } = await createTestOrgAndMatter("dt-wrong-matter-a");
    const { matterId: matterB } = await createTestOrgAndMatter("dt-wrong-matter-b");
    try {
      const tagInB = await createTestTag(orgId, matterB, "Belongs To B");
      const docInA = await createTestDocument(orgId, matterA);
      const app = buildTestApp({ orgId, userId, role: "reviewer", email: "tester@example.com" });

      const response = await request(app).post(`/api/matters/${matterA}/document-tags/apply`).send({ documentIds: [docInA], tagId: tagInB });
      expect(response.status).toBe(404);

      const rows = await withOrgSession(orgId, (client) => client.query("SELECT * FROM document_tags WHERE document_id = $1", [docInA]));
      expect(rows.rowCount).toBe(0);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("cross-org: a different org's session inserts nothing against this matter/documents", async () => {
    const { orgId: orgA, matterId } = await createTestOrgAndMatter("dt-cross-org-a");
    const { orgId: orgB, userId: userB } = await createTestOrgAndMatter("dt-cross-org-b");
    try {
      const tagId = await createTestTag(orgA, matterId, "Org A Tag");
      const docId = await createTestDocument(orgA, matterId);
      const appB = buildTestApp({ orgId: orgB, userId: userB, role: "reviewer", email: "tester@example.com" });

      await request(appB).post(`/api/matters/${matterId}/document-tags/apply`).send({ documentIds: [docId], tagId });

      const rows = await withOrgSession(orgA, (client) => client.query("SELECT * FROM document_tags WHERE document_id = $1", [docId]));
      expect(rows.rowCount).toBe(0);
    } finally {
      await deleteTestOrg(orgA);
      await deleteTestOrg(orgB);
    }
  });

  it("deleting a document cascades its document_tags rows", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("dt-cascade-delete");
    try {
      const tagId = await createTestTag(orgId, matterId, "Cascade Test");
      const docId = await createTestDocument(orgId, matterId);
      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });

      await request(app).post(`/api/matters/${matterId}/document-tags/apply`).send({ documentIds: [docId], tagId });
      const del = await request(app).delete(`/api/matters/${matterId}/documents/${docId}`);
      expect(del.status).toBe(204);

      const rows = await withOrgSession(orgId, (client) => client.query("SELECT * FROM document_tags WHERE document_id = $1", [docId]));
      expect(rows.rowCount).toBe(0);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("apply/remove as litigation_support is forbidden", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("dt-role-gate");
    try {
      const tagId = await createTestTag(orgId, matterId, "Gated");
      const docId = await createTestDocument(orgId, matterId);
      const app = buildTestApp({ orgId, userId, role: "litigation_support", email: "tester@example.com" });

      const apply = await request(app).post(`/api/matters/${matterId}/document-tags/apply`).send({ documentIds: [docId], tagId });
      expect(apply.status).toBe(403);
      const remove = await request(app).post(`/api/matters/${matterId}/document-tags/remove`).send({ documentIds: [docId], tagId });
      expect(remove.status).toBe(403);
    } finally {
      await deleteTestOrg(orgId);
    }
  });
});
