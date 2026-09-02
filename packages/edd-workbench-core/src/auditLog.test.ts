import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "./pool.js";
import { withOrgSession } from "./session.js";
import { recordAuditEvent } from "./auditLog.js";

describe("recordAuditEvent", () => {
  let orgId: string;
  let userId: string;
  let matterId: string;

  beforeAll(async () => {
    orgId = `org_test_${randomUUID()}`;
    userId = `auth0|${randomUUID()}`;

    ({ matterId } = await withOrgSession(orgId, async (client) => {
      const matter = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [
        orgId,
        "auditLog test matter",
      ]);
      return { matterId: matter.rows[0].id };
    }));
  });

  afterAll(async () => {
    await withOrgSession(orgId, async (client) => {
      await client.query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
      await client.query("DELETE FROM matters WHERE org_id = $1", [orgId]);
    });
    await pool.end();
  });

  it("inserts a row with every field, retrievable exactly as given", async () => {
    await withOrgSession(orgId, (client) =>
      recordAuditEvent(client, {
        orgId,
        actorUserId: userId,
        matterId,
        action: "matter.create",
        description: 'Created matter "Test Matter"',
        details: { referenceCode: "REF-1" },
      }),
    );

    const rows = await withOrgSession(orgId, (client) =>
      client.query("SELECT action, description, details, matter_id, document_id FROM audit_log WHERE actor_user_id = $1", [userId]),
    );
    expect(rows.rows).toEqual([
      {
        action: "matter.create",
        description: 'Created matter "Test Matter"',
        details: { referenceCode: "REF-1" },
        matter_id: matterId,
        document_id: null,
      },
    ]);
  });

  it("defaults matterId/documentId/details to null when omitted", async () => {
    await withOrgSession(orgId, (client) =>
      recordAuditEvent(client, { orgId, actorUserId: userId, action: "logout", description: "User logged out" }),
    );

    const rows = await withOrgSession(orgId, (client) =>
      client.query("SELECT matter_id, document_id, details FROM audit_log WHERE actor_user_id = $1 AND action = 'logout'", [userId]),
    );
    expect(rows.rows).toEqual([{ matter_id: null, document_id: null, details: null }]);
  });

  it("survives the referenced matter later being deleted — ON DELETE SET NULL, not CASCADE", async () => {
    const doomedMatterId = await withOrgSession(orgId, async (client) => {
      const matter = await client.query<{ id: string }>("INSERT INTO matters (org_id, name) VALUES ($1, $2) RETURNING id", [orgId, "Doomed matter"]);
      await recordAuditEvent(client, {
        orgId,
        actorUserId: userId,
        matterId: matter.rows[0].id,
        action: "matter.create",
        description: 'Created matter "Doomed matter"',
      });
      return matter.rows[0].id;
    });

    await withOrgSession(orgId, (client) => client.query("DELETE FROM matters WHERE id = $1", [doomedMatterId]));

    const rows = await withOrgSession(orgId, (client) =>
      client.query("SELECT matter_id, description FROM audit_log WHERE description = $1", ['Created matter "Doomed matter"']),
    );
    // The row itself survives — matter_id is nulled out, but the rendered
    // description (captured at write time) still says which matter it was.
    expect(rows.rows).toEqual([{ matter_id: null, description: 'Created matter "Doomed matter"' }]);
  });

  it("never returns another organization's audit rows", async () => {
    const otherOrgId = `org_test_${randomUUID()}`;
    try {
      await withOrgSession(otherOrgId, async (client) => {
        const otherUserId = `auth0|${randomUUID()}`;
        await recordAuditEvent(client, { orgId: otherOrgId, actorUserId: otherUserId, action: "logout", description: "Other org logout" });
      });

      const rows = await withOrgSession(orgId, (client) => client.query("SELECT 1 FROM audit_log WHERE description = 'Other org logout'"));
      expect(rows.rowCount).toBe(0);
    } finally {
      await withOrgSession(otherOrgId, (client) => client.query("DELETE FROM audit_log WHERE org_id = $1", [otherOrgId]));
    }
  });
});
