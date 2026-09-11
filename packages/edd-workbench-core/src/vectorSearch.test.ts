import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withOrgSession } from "./session.js";
import { enableIterativeVectorScan } from "./vectorSearch.js";

// Runs against the real local pgvector (pgvector/pgvector:pg16 — see
// docker-compose.yml), not a stub. Whether a real pgvector actually honours
// the setting, and whether setting it BEFORE the extension's library has
// been lazily loaded works at all, is not something a stub can answer —
// and the load-order detail is precisely what broke the first attempt at
// this function.
describe("enableIterativeVectorScan", () => {
  const orgId = `org_test_${randomUUID()}`;

  it("takes effect even when set before the session's first vector operation, which is when pgvector's GUCs actually come into existence", async () => {
    const effective = await withOrgSession(orgId, async (client) => {
      // Deliberately the very first statement: a fresh pooled connection
      // has not loaded pgvector's library yet, so hnsw.iterative_scan does
      // not exist as a real GUC at this point — only as a placeholder.
      await enableIterativeVectorScan(client);

      // Any vector operation forces the library to load, at which point the
      // placeholder set above is claimed and validated.
      await client.query("SELECT '[1,2,3]'::vector <=> '[1,2,4]'::vector AS distance");

      const current = await client.query<{ value: string | null }>("SELECT current_setting('hnsw.iterative_scan', true) AS value");
      return current.rows[0].value;
    });

    const installed = await withOrgSession(orgId, (client) =>
      client.query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'vector'"),
    );
    const [major, minor] = installed.rows[0].extversion.split(".").map(Number);
    const supportsIterativeScan = major > 0 || minor >= 8;

    if (supportsIterativeScan) {
      expect(effective).toBe("relaxed_order");
    } else {
      // Older pgvector never claims the placeholder — the point is that
      // this degrades silently rather than erroring.
      expect(effective).not.toBe("relaxed_order");
    }
  });

  // The reason it's SET LOCAL rather than SET: these run on a pooled
  // connection, so a session-level setting would follow that connection
  // into the next request — a different org's, potentially.
  it("does not leak the setting past its own transaction", async () => {
    await withOrgSession(orgId, async (client) => {
      await enableIterativeVectorScan(client);
      await client.query("SELECT '[1,2,3]'::vector <=> '[1,2,4]'::vector AS distance");
    });

    const after = await withOrgSession(orgId, (client) =>
      client.query<{ value: string | null }>("SELECT current_setting('hnsw.iterative_scan', true) AS value"),
    );
    // 'off' is pgvector's own default once loaded; null if this connection
    // has not loaded the library at all. Never the value set above.
    expect(after.rows[0].value === null || after.rows[0].value === "off").toBe(true);
  });

  // An unrecognized GUC would abort the transaction, taking the whole /ask
  // request with it — so this must be safe to call unconditionally,
  // whatever pgvector version is deployed.
  it("never throws, so an older pgvector degrades instead of failing the request", async () => {
    await expect(
      withOrgSession(orgId, async (client) => {
        await enableIterativeVectorScan(client);
        return client.query("SELECT 1");
      }),
    ).resolves.toBeDefined();
  });
});
