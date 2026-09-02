import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "./pool.js";
import { withOrgSession } from "./session.js";
import { formatGuid, initMatterGuidCounter, nextMatterGuid } from "./guidCounter.js";

describe("guidCounter", () => {
  let orgId: string;
  let matterId: string;

  beforeAll(async () => {
    // Opaque Auth0-shaped string, not a local uuid — no organizations table
    // left to seed at all.
    orgId = `org_test_${randomUUID()}`;

    matterId = await withOrgSession(orgId, async (client) => {
      const row = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
        orgId,
        "Sequential test matter",
      ]);
      const id = row.rows[0].id;
      await initMatterGuidCounter(client, id);
      return id;
    });
  });

  afterAll(async () => {
    // Cascades to matter_guid_counters (ON DELETE CASCADE from matters —
    // see migration 005).
    await withOrgSession(orgId, (client) => client.query("DELETE FROM matters WHERE org_id = $1", [orgId]));
    await pool.end();
  });

  it("formats a sequence number as a zero-padded 6-digit string", () => {
    expect(formatGuid(1)).toBe("000001");
    expect(formatGuid(42)).toBe("000042");
    expect(formatGuid(123456)).toBe("123456");
  });

  it("assigns sequential numbers starting at 1", async () => {
    const first = await withOrgSession(orgId, (client) => nextMatterGuid(client, matterId));
    const second = await withOrgSession(orgId, (client) => nextMatterGuid(client, matterId));
    const third = await withOrgSession(orgId, (client) => nextMatterGuid(client, matterId));

    expect([first, second, third]).toEqual([1, 2, 3]);
  });

  it("throws a clear error for a matter with no counter row", async () => {
    const orphanMatterId = await withOrgSession(orgId, async (client) => {
      const row = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
        orgId,
        "Matter with no counter (should never happen via the real API, but the function must fail loudly if it does)",
      ]);
      return row.rows[0].id;
      // Deliberately never calls initMatterGuidCounter — reproduces the one
      // way this can go wrong: a caller that skips it.
    });

    await expect(withOrgSession(orgId, (client) => nextMatterGuid(client, orphanMatterId))).rejects.toThrow(
      /No GUID counter found/,
    );
  });

  it("assigns gapless, unique numbers under concurrent calls — the property the whole design depends on", async () => {
    const concurrentMatterId = await withOrgSession(orgId, async (client) => {
      const row = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
        orgId,
        "Concurrent test matter",
      ]);
      const id = row.rows[0].id;
      await initMatterGuidCounter(client, id);
      return id;
    });

    const CONCURRENCY = 20;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => withOrgSession(orgId, (client) => nextMatterGuid(client, concurrentMatterId))),
    );

    // No duplicates...
    expect(new Set(results).size).toBe(CONCURRENCY);
    // ...and no gaps: exactly {1, 2, ..., CONCURRENCY}, nothing skipped even
    // though CONCURRENCY requests raced the same row's lock simultaneously.
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i + 1));
  });
});
