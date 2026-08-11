import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Client } from "pg";
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
  const client = new Client({ connectionString: "postgres://postgres:postgres@localhost:5432/edd_workbench_test" });
  await client.connect();
  await client.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  await client.end();
}

async function createTestOrg(namePrefix: string) {
  const orgId = randomUUID();
  await pool.query("INSERT INTO organizations (id, name, auth0_org_id) VALUES ($1, $2, $3)", [
    orgId,
    `${namePrefix} test org`,
    `test-org-${orgId}`,
  ]);
  const userId = await withOrgSession(orgId, async (client) => {
    const userRow = await client.query<{ id: string }>("INSERT INTO users (auth0_user_id, email) VALUES ($1, $2) RETURNING id", [
      `auth0|${randomUUID()}`,
      "tester@example.com",
    ]);
    return userRow.rows[0].id;
  });
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
        "Privilege:Work Product:#B4551F",
        "Review:Responsive:#3F7D2C",
        "Review:Not Responsive:",
        "Review:Hot Doc:#B03362",
      ]);
    } finally {
      await deleteTestOrg(orgId);
    }
  });
});
