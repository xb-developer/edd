import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withOrgSession } from "./session.js";
import { recordAiUsage, getAiUsageForUser } from "./aiUsage.js";

async function getTotals(orgId: string): Promise<{ user_id: string; call_site: string; total_tokens: string }[]> {
  const rows = await withOrgSession(orgId, (client) =>
    client.query("SELECT user_id, call_site, total_tokens FROM ai_usage WHERE org_id = $1 ORDER BY user_id, call_site", [orgId]),
  );
  return rows.rows;
}

// No afterEach cleanup — ai_usage is an increment-only counter table (see
// migration 028's GRANT, deliberately SELECT/INSERT/UPDATE only, matching
// audit_log's own append-only precedent), so the app role has no DELETE
// grant to clean up with. Each test uses its own fresh random org_id, and
// RLS scopes every query to it, so leftover rows from a previous run are
// simply invisible to (and harmless for) the next one.
describe("recordAiUsage", () => {
  it("inserts a new row on the first call for a (org, user, call_site)", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;

    await recordAiUsage(orgId, userId, "embedding", 100);

    expect(await getTotals(orgId)).toEqual([{ user_id: userId, call_site: "embedding", total_tokens: "100" }]);
  });

  it("adds to the existing total, rather than overwriting it, on a second call", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;

    await recordAiUsage(orgId, userId, "embedding", 100);
    await recordAiUsage(orgId, userId, "embedding", 50);

    expect(await getTotals(orgId)).toEqual([{ user_id: userId, call_site: "embedding", total_tokens: "150" }]);
  });

  it("keeps separate running totals per call_site for the same user", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;

    await recordAiUsage(orgId, userId, "embedding", 100);
    await recordAiUsage(orgId, userId, "ask", 10);
    await recordAiUsage(orgId, userId, "summarization", 20);

    expect(await getTotals(orgId)).toEqual([
      { user_id: userId, call_site: "ask", total_tokens: "10" },
      { user_id: userId, call_site: "embedding", total_tokens: "100" },
      { user_id: userId, call_site: "summarization", total_tokens: "20" },
    ]);
  });

  it("keeps separate running totals per user for the same call_site", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userA = `auth0|${randomUUID()}`;
    const userB = `auth0|${randomUUID()}`;

    await recordAiUsage(orgId, userA, "ask", 10);
    await recordAiUsage(orgId, userB, "ask", 20);

    // getTotals orders by user_id, and these are random UUIDs — sort the
    // expectation the same way rather than asserting a fixed order that
    // happens to depend on which random UUID sorts first.
    expect(await getTotals(orgId)).toEqual(
      [
        { user_id: userA, call_site: "ask", total_tokens: "10" },
        { user_id: userB, call_site: "ask", total_tokens: "20" },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
  });

  it("is a no-op for zero or negative token counts", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;

    await recordAiUsage(orgId, userId, "ask", 0);
    await recordAiUsage(orgId, userId, "ask", -5);

    expect(await getTotals(orgId)).toEqual([]);
  });
});

describe("getAiUsageForUser", () => {
  it("defaults every call site to 0 for a user with no usage yet", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;

    expect(await getAiUsageForUser(orgId, userId)).toEqual({ embedding: 0, ask: 0, summarization: 0, total: 0 });
  });

  it("returns each call site's own total plus their sum", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;

    await recordAiUsage(orgId, userId, "embedding", 100);
    await recordAiUsage(orgId, userId, "ask", 10);
    await recordAiUsage(orgId, userId, "summarization", 20);

    expect(await getAiUsageForUser(orgId, userId)).toEqual({ embedding: 100, ask: 10, summarization: 20, total: 130 });
  });

  it("never includes another user's usage in this org", async () => {
    const orgId = `org_test_${randomUUID()}`;
    const userId = `auth0|${randomUUID()}`;
    const otherUserId = `auth0|${randomUUID()}`;

    await recordAiUsage(orgId, otherUserId, "ask", 999);

    expect(await getAiUsageForUser(orgId, userId)).toEqual({ embedding: 0, ask: 0, summarization: 0, total: 0 });
  });
});
