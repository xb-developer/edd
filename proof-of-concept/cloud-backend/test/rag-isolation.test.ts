import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, withTenantContext } from "../src/db/pool.js";
import { uploadDocument } from "../src/documents/uploadDocument.js";
import { askMatter } from "../src/rag/ask.js";
import { drainJobs } from "./helpers.js";

const admin = { organizationId: null, userId: null, isPlatformAdmin: true } as const;

interface Seeded {
  orgA: string;
  groupA1: string;
  userA1: string;
  matterA1: string;
  orgB: string;
  groupB1: string;
  userB1: string;
  matterB1: string;
}

let seeded: Seeded;

before(async () => {
  const base = await withTenantContext(admin, async (client) => {
    const org = async (name: string) => {
      const { rows } = await client.query(
        "INSERT INTO organizations (auth0_org_id, name) VALUES ($1, $2) RETURNING id",
        [`auth0|rag-org-${name}-${Date.now()}-${Math.random()}`, `RAG Org ${name}`],
      );
      return rows[0].id as string;
    };
    const user = async (orgId: string, email: string) => {
      const { rows } = await client.query(
        "INSERT INTO users (auth0_user_id, organization_id, email) VALUES ($1, $2, $3) RETURNING id",
        [`auth0|rag-user-${email}-${Date.now()}-${Math.random()}`, orgId, email],
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
    const groupA1 = await group(orgA, "RAG Team A1");
    const groupB1 = await group(orgB, "RAG Team B1");
    const userA1 = await user(orgA, "rag-a1@example.com");
    const userB1 = await user(orgB, "rag-b1@example.com");
    await client.query("INSERT INTO group_members (group_id, user_id, organization_id) VALUES ($1, $2, $3)", [
      groupA1,
      userA1,
      orgA,
    ]);
    await client.query("INSERT INTO group_members (group_id, user_id, organization_id) VALUES ($1, $2, $3)", [
      groupB1,
      userB1,
      orgB,
    ]);

    return { orgA, groupA1, userA1, orgB, groupB1, userB1 };
  });

  const matterA1 = await withTenantContext(
    { organizationId: base.orgA, userId: base.userA1, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query(
        "INSERT INTO matters (organization_id, group_id, created_by_user_id, name) VALUES ($1, $2, $3, $4) RETURNING id",
        [base.orgA, base.groupA1, base.userA1, "RAG Matter A1"],
      );
      return rows[0].id as string;
    },
  );
  const matterB1 = await withTenantContext(
    { organizationId: base.orgB, userId: base.userB1, isPlatformAdmin: false },
    async (client) => {
      const { rows } = await client.query(
        "INSERT INTO matters (organization_id, group_id, created_by_user_id, name) VALUES ($1, $2, $3, $4) RETURNING id",
        [base.orgB, base.groupB1, base.userB1, "RAG Matter B1"],
      );
      return rows[0].id as string;
    },
  );

  seeded = { ...base, matterA1, matterB1 };

  // Seed each matter with distinguishable, made-up content that can't
  // plausibly appear in the model's own training data — so a leaked answer
  // is unambiguously traceable to the wrong matter, not a coincidence.
  const tenantA = { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false };
  const tenantB = { organizationId: seeded.orgB, userId: seeded.userB1, isPlatformAdmin: false };

  await uploadDocument(tenantA, seeded.matterA1, {
    originalname: "project-falcon-memo.txt",
    mimetype: "text/plain",
    size: 0,
    buffer: Buffer.from("The internal code word for Project Falcon's launch is PURPLE ELEPHANT."),
  });
  await uploadDocument(tenantB, seeded.matterB1, {
    originalname: "project-osprey-memo.txt",
    mimetype: "text/plain",
    size: 0,
    buffer: Buffer.from("The internal code word for Project Osprey's launch is SILVER FOXTROT."),
  });

  await drainJobs();
});

after(async () => {
  await pool.end();
});

test(
  "retrieval for one matter never surfaces another matter's chunks, even with an identically-shaped question",
  async () => {
    const tenantA = { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false };
    const chunks = await withTenantContext(tenantA, async (client) => {
      const { rows } = await client.query("SELECT text FROM chunks WHERE matter_id = $1", [seeded.matterA1]);
      return rows;
    });
    assert.ok(chunks.length > 0, "matter A should have its own chunks");
    for (const chunk of chunks) {
      assert.doesNotMatch(chunk.text, /SILVER FOXTROT|Osprey/, "matter A's chunks must not contain matter B's content");
    }
  },
);

test(
  "asking a question against Matter A only ever cites Matter A's document, and the answer contains none of Matter B's secret",
  async () => {
    const tenantA = { organizationId: seeded.orgA, userId: seeded.userA1, isPlatformAdmin: false };

    const result = await askMatter(tenantA, seeded.matterA1, "What is the internal code word for the launch?");

    for (const citation of result.citations) {
      assert.match(citation.filename, /falcon/i, "every citation must be Matter A's own document");
    }
    assert.doesNotMatch(
      result.answer,
      /SILVER FOXTROT|Osprey/i,
      "the generated answer must not contain Matter B's secret",
    );
    assert.match(result.answer, /PURPLE ELEPHANT/, "the answer should actually use Matter A's real content");
  },
);
