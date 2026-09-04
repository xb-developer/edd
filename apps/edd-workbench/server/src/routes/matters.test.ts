import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { pool, withOrgSession } from "@xbundle/edd-workbench-core";
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
    await client.query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
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
