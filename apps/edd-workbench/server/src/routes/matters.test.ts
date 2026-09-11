import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, withOrgSession, s3Client, DOCUMENTS_BUCKET } from "@xbundle/edd-workbench-core";
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { mattersRouter } from "./matters.js";
import type { EddRequestContext } from "../auth.js";

function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/matters", mattersRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

async function deleteTestOrg(orgId: string): Promise<void> {
  await withOrgSession(orgId, async (client) => {
    await client.query("DELETE FROM matters WHERE org_id = $1", [orgId]);
  });
}

// orgId/userId are opaque Auth0-shaped strings now — no local
// organizations/users tables left to seed.
async function createTestOrg(namePrefix: string) {
  const orgId = `org_test_${namePrefix}_${randomUUID()}`;
  const userId = `auth0|${randomUUID()}`;
  return { orgId, userId };
}

// Raw insert, matching documents.test.ts's own insertTestDocument (a
// childless doc is its own family root) — matter-delete tests below only
// need real documents to exist under the matter, not a real ingest run.
async function insertTestDocument(orgId: string, matterId: string, guidNumber: number, filename: string, s3Key: string): Promise<string> {
  return withOrgSession(orgId, async (client) => {
    const documentId = randomUUID();
    await client.query(
      `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status)
       VALUES ($1, $2, $3, NULL, $1, 0, $4, $5, 'pdf', 100, $6, 'pdf', 'ready')`,
      [documentId, orgId, matterId, guidNumber, filename, s3Key],
    );
    return documentId;
  });
}

afterAll(async () => {
  await pool.end();
});

describe("matters router — POST /", () => {
  it("seeds the same built-in Privilege/Review tag sets migration 013/014's backfill gives every pre-existing matter", async () => {
    const { orgId, userId } = await createTestOrg("matters-seed-tags");
    try {
      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      const response = await request(app).post("/api/matters").send({ name: "New Matter" });
      expect(response.status).toBe(201);
      const matterId = response.body.id;

      const rows = await withOrgSession(orgId, (client) =>
        client.query(
          `SELECT ts.name AS set_name, t.name AS tag_name, t.color
           FROM tag_sets ts LEFT JOIN tags t ON t.tag_set_id = ts.id
           WHERE ts.matter_id = $1 ORDER BY ts.position, t.position`,
          [matterId],
        ),
      );

      expect(rows.rows.map((r) => `${r.set_name}:${r.tag_name}:${r.color ?? ""}`)).toEqual([
        "Privilege:Privileged:#A6362C",
        "Privilege:Not Privileged:#B4551F",
        "Review:Relevant:#3F7D2C",
        "Review:Not Relevant:",
        "Review:Hot Doc:#B03362",
      ]);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("auto-adds a non-admin creator to the matter's own access list and writes a matter.create audit row", async () => {
    const { orgId, userId } = await createTestOrg("matters-create-audit");
    try {
      const app = buildTestApp({ orgId, userId, role: "litigation_support", email: "tester@example.com" });
      const response = await request(app).post("/api/matters").send({ name: "Audited Matter" });
      const matterId = response.body.id;

      const membership = await withOrgSession(orgId, (client) =>
        client.query("SELECT 1 FROM matter_members WHERE matter_id = $1 AND user_id = $2", [matterId, userId]),
      );
      expect(membership.rowCount).toBe(1);

      const audit = await withOrgSession(orgId, (client) =>
        client.query("SELECT action, description, actor_user_id FROM audit_log WHERE matter_id = $1", [matterId]),
      );
      expect(audit.rows).toEqual([{ action: "matter.create", description: 'Created matter "Audited Matter"', actor_user_id: userId }]);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("does NOT add an admin creator to matter_members — admins bypass the list entirely", async () => {
    const { orgId, userId } = await createTestOrg("matters-create-admin");
    try {
      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      const response = await request(app).post("/api/matters").send({ name: "Admin-created matter" });
      const matterId = response.body.id;

      const membership = await withOrgSession(orgId, (client) =>
        client.query("SELECT 1 FROM matter_members WHERE matter_id = $1 AND user_id = $2", [matterId, userId]),
      );
      expect(membership.rowCount).toBe(0);
    } finally {
      await deleteTestOrg(orgId);
    }
  });
});

describe("matters router — PATCH /:id", () => {
  it("renames a matter", async () => {
    const { orgId, userId } = await createTestOrg("matters-rename");
    try {
      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      const created = await request(app).post("/api/matters").send({ name: "New matter" });
      const matterId = created.body.id;

      const response = await request(app).patch(`/api/matters/${matterId}`).send({ name: "  Smith v Jones  " });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: matterId, name: "Smith v Jones" });

      const row = await withOrgSession(orgId, (client) => client.query("SELECT name FROM matters WHERE id = $1", [matterId]));
      expect(row.rows[0].name).toBe("Smith v Jones");
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("400s for an empty or whitespace-only name", async () => {
    const { orgId, userId } = await createTestOrg("matters-rename-empty");
    try {
      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      const created = await request(app).post("/api/matters").send({ name: "New matter" });
      const matterId = created.body.id;

      const response = await request(app).patch(`/api/matters/${matterId}`).send({ name: "   " });
      expect(response.status).toBe(400);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("404s for a matter that doesn't exist", async () => {
    const { orgId, userId } = await createTestOrg("matters-rename-missing");
    try {
      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      const response = await request(app).patch(`/api/matters/${randomUUID()}`).send({ name: "Anything" });
      expect(response.status).toBe(404);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("never renames another organization's matter", async () => {
    const { orgId: orgA, userId: userA } = await createTestOrg("matters-rename-org-a");
    const { orgId: orgB, userId: userB } = await createTestOrg("matters-rename-org-b");
    try {
      const appB = buildTestApp({ orgId: orgB, userId: userB, role: "admin", email: "tester@example.com" });
      const created = await request(appB).post("/api/matters").send({ name: "Org B matter" });
      const matterId = created.body.id;

      const appA = buildTestApp({ orgId: orgA, userId: userA, role: "admin", email: "tester@example.com" });
      const response = await request(appA).patch(`/api/matters/${matterId}`).send({ name: "Hijacked" });
      expect(response.status).toBe(404);

      const row = await withOrgSession(orgB, (client) => client.query("SELECT name FROM matters WHERE id = $1", [matterId]));
      expect(row.rows[0].name).toBe("Org B matter");
    } finally {
      await deleteTestOrg(orgA);
      await deleteTestOrg(orgB);
    }
  });
});

describe("matters router — DELETE /:id", () => {
  beforeAll(async () => {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
    } catch {
      await s3Client.send(new CreateBucketCommand({ Bucket: DOCUMENTS_BUCKET }));
    }
  });

  it("deletes the matter, cascades its documents/tag sets/members, cleans up S3 objects, and records a matter.delete audit row", async () => {
    const { orgId, userId } = await createTestOrg("matters-delete");
    try {
      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      const created = await request(app).post("/api/matters").send({ name: "Matter to delete" });
      const matterId = created.body.id;

      const s3Key = `tenants/test/documents/${randomUUID()}/original.pdf`;
      await s3Client.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: Buffer.from("real bytes") }));
      const documentId = await insertTestDocument(orgId, matterId, 1, "bundle.pdf", s3Key);

      const response = await request(app).delete(`/api/matters/${matterId}`).send();
      expect(response.status).toBe(204);

      const matterRow = await withOrgSession(orgId, (client) => client.query("SELECT 1 FROM matters WHERE id = $1", [matterId]));
      expect(matterRow.rowCount).toBe(0);

      const docRow = await withOrgSession(orgId, (client) => client.query("SELECT 1 FROM documents WHERE id = $1", [documentId]));
      expect(docRow.rowCount).toBe(0);
      await expect(s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key }))).rejects.toBeTruthy();

      const tagSets = await withOrgSession(orgId, (client) => client.query("SELECT 1 FROM tag_sets WHERE matter_id = $1", [matterId]));
      expect(tagSets.rowCount).toBe(0);

      // matter_id ends up NULL (ON DELETE SET NULL, migration 023) the
      // instant the DELETE above cascades — same as every other audit row
      // for this matter, including the matter.create one from setup. The
      // rendered description is what still identifies which matter this was.
      const audit = await withOrgSession(orgId, (client) =>
        client.query("SELECT action, description, matter_id FROM audit_log WHERE org_id = $1 AND action = 'matter.delete'", [orgId]),
      );
      expect(audit.rows).toEqual([{ action: "matter.delete", description: 'Deleted matter "Matter to delete"', matter_id: null }]);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it.each(["reviewer", "litigation_support"] as const)("403s for a non-admin (%s) — only admin may delete a matter", async (role) => {
    const { orgId, userId } = await createTestOrg(`matters-delete-403-${role}`);
    try {
      const adminApp = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      const created = await request(adminApp).post("/api/matters").send({ name: "Protected matter" });
      const matterId = created.body.id;

      const nonAdminApp = buildTestApp({ orgId, userId, role, email: "tester@example.com" });
      const response = await request(nonAdminApp).delete(`/api/matters/${matterId}`).send();
      expect(response.status).toBe(403);

      const matterRow = await withOrgSession(orgId, (client) => client.query("SELECT 1 FROM matters WHERE id = $1", [matterId]));
      expect(matterRow.rowCount).toBe(1);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("404s for a matter that doesn't exist", async () => {
    const { orgId, userId } = await createTestOrg("matters-delete-missing");
    try {
      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      const response = await request(app).delete(`/api/matters/${randomUUID()}`).send();
      expect(response.status).toBe(404);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("never deletes another organization's matter", async () => {
    const { orgId: orgA, userId: userA } = await createTestOrg("matters-delete-org-a");
    const { orgId: orgB, userId: userB } = await createTestOrg("matters-delete-org-b");
    try {
      const appB = buildTestApp({ orgId: orgB, userId: userB, role: "admin", email: "tester@example.com" });
      const created = await request(appB).post("/api/matters").send({ name: "Org B matter" });
      const matterId = created.body.id;

      const appA = buildTestApp({ orgId: orgA, userId: userA, role: "admin", email: "tester@example.com" });
      const response = await request(appA).delete(`/api/matters/${matterId}`).send();
      expect(response.status).toBe(404);

      const row = await withOrgSession(orgB, (client) => client.query("SELECT 1 FROM matters WHERE id = $1", [matterId]));
      expect(row.rowCount).toBe(1);
    } finally {
      await deleteTestOrg(orgA);
      await deleteTestOrg(orgB);
    }
  });
});
