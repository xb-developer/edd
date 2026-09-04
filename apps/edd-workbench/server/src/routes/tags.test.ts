import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { pool, withOrgSession, initMatterGuidCounter } from "@xbundle/edd-workbench-core";
import { tagsRouter } from "./tags.js";
import type { EddRequestContext } from "../auth.js";

// Mounts only the tags router, with a test-only middleware injecting
// req.eddContext directly — same convention as documents.test.ts.
function buildTestApp(eddContext: EddRequestContext) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.eddContext = eddContext;
    next();
  });
  app.use("/api/matters/:matterId/tags", tagsRouter);
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
  await withOrgSession(orgId, async (client) => {
    await client.query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await client.query("DELETE FROM matters WHERE org_id = $1", [orgId]);
  });
}

// Mirrors matters.ts's own POST / handler's tag-set seeding exactly, since
// this test file creates matters via a raw INSERT (bypassing the route) —
// without this, a real matter created through the app would have tag sets
// and a test matter created here wouldn't, which would make every
// assertion below test something that can't happen in production.
async function createTestOrgAndMatter(namePrefix: string) {
  const orgId = `org_test_${randomUUID()}`;
  const userId = `auth0|${randomUUID()}`;

  return withOrgSession(orgId, async (client) => {
    const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
      orgId,
      `${namePrefix} test matter`,
    ]);
    await initMatterGuidCounter(client, matterRow.rows[0].id);

    const privilege = await client.query<{ id: string }>(
      "INSERT INTO tag_sets (org_id, matter_id, name, position) VALUES ($1, $2, 'Privilege', 0) RETURNING id",
      [orgId, matterRow.rows[0].id],
    );
    await client.query(
      `INSERT INTO tags (org_id, matter_id, tag_set_id, name, color, position) VALUES
       ($1, $2, $3, 'Priviledged', '#A6362C', 0), ($1, $2, $3, 'Not Priviledged', '#B4551F', 1)`,
      [orgId, matterRow.rows[0].id, privilege.rows[0].id],
    );
    const review = await client.query<{ id: string }>(
      "INSERT INTO tag_sets (org_id, matter_id, name, position) VALUES ($1, $2, 'Review', 1) RETURNING id",
      [orgId, matterRow.rows[0].id],
    );
    await client.query(
      `INSERT INTO tags (org_id, matter_id, tag_set_id, name, color, position) VALUES
       ($1, $2, $3, 'Relevant', '#3F7D2C', 0), ($1, $2, $3, 'Not Relevant', NULL, 1), ($1, $2, $3, 'Hot Doc', '#B03362', 2)`,
      [orgId, matterRow.rows[0].id, review.rows[0].id],
    );

    return { orgId, matterId: matterRow.rows[0].id, userId };
  });
}

afterAll(async () => {
  await pool.end();
});

describe("tags router", () => {
  it("GET / returns the two seeded built-in sets, grouped, in position order, matching the old mock's names/colors", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("tags-get");
    try {
      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      const response = await request(app).get(`/api/matters/${matterId}/tags`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(response.body[0].name).toBe("Privilege");
      expect(response.body[0].tags.map((t: { name: string }) => t.name)).toEqual(["Priviledged", "Not Priviledged"]);
      expect(response.body[0].tags[0].color).toBe("#A6362C");
      expect(response.body[1].name).toBe("Review");
      expect(response.body[1].tags.map((t: { name: string }) => t.name)).toEqual(["Relevant", "Not Relevant", "Hot Doc"]);
      expect(response.body[1].tags[1].color).toBeUndefined();
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("POST /custom creates a new tag under a lazily-created Custom set", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("tags-custom");
    try {
      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      const response = await request(app).post(`/api/matters/${matterId}/tags/custom`).send({ name: "Needs Redaction" });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe("Needs Redaction");

      const sets = await request(app).get(`/api/matters/${matterId}/tags`);
      const customSet = sets.body.find((s: { name: string }) => s.name === "Custom");
      expect(customSet).toBeDefined();
      expect(customSet.tags.map((t: { name: string }) => t.name)).toContain("Needs Redaction");
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("POST /custom called twice with different casing reuses the same tag, not a duplicate", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("tags-dedupe");
    try {
      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      const first = await request(app).post(`/api/matters/${matterId}/tags/custom`).send({ name: "Hot" });
      const second = await request(app).post(`/api/matters/${matterId}/tags/custom`).send({ name: "hot" });

      expect(first.body.id).toBe(second.body.id);

      const rows = await withOrgSession(orgId, (client) => client.query("SELECT * FROM tags WHERE matter_id = $1 AND lower(name) = 'hot'", [matterId]));
      expect(rows.rowCount).toBe(1);
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("a custom tag created in matter A is invisible from matter B in the same org", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;
    try {
      const { matterId: matterA } = await withOrgSession(orgId, async (client) => {
        const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
          orgId,
          "matter A",
        ]);
        await initMatterGuidCounter(client, matterRow.rows[0].id);
        return { matterId: matterRow.rows[0].id };
      });
      const matterB = await withOrgSession(orgId, async (client) => {
        const matterRow = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
          orgId,
          "matter B",
        ]);
        await initMatterGuidCounter(client, matterRow.rows[0].id);
        return matterRow.rows[0].id;
      });

      const app = buildTestApp({ orgId, userId, role: "admin", email: "tester@example.com" });
      await request(app).post(`/api/matters/${matterA}/tags/custom`).send({ name: "Matter A Only" });

      const bSets = await request(app).get(`/api/matters/${matterB}/tags`);
      const names = bSets.body.flatMap((s: { tags: { name: string }[] }) => s.tags.map((t) => t.name));
      expect(names).not.toContain("Matter A Only");
    } finally {
      await deleteTestOrg(orgId);
    }
  });

  it("a matter in a different org is invisible (cross-org isolation)", async () => {
    const { orgId: orgA, matterId } = await createTestOrgAndMatter("tags-cross-org-a");
    const { orgId: orgB, userId: userB } = await createTestOrgAndMatter("tags-cross-org-b");
    try {
      const app = buildTestApp({ orgId: orgB, userId: userB, role: "admin", email: "tester@example.com" });
      const response = await request(app).get(`/api/matters/${matterId}/tags`);
      expect(response.body).toEqual([]);
    } finally {
      await deleteTestOrg(orgA);
      await deleteTestOrg(orgB);
    }
  });

  it("POST /custom as litigation_support is forbidden", async () => {
    const { orgId, matterId, userId } = await createTestOrgAndMatter("tags-role-gate");
    try {
      const app = buildTestApp({ orgId, userId, role: "litigation_support", email: "tester@example.com" });
      const response = await request(app).post(`/api/matters/${matterId}/tags/custom`).send({ name: "Should Not Work" });
      expect(response.status).toBe(403);
    } finally {
      await deleteTestOrg(orgId);
    }
  });
});
