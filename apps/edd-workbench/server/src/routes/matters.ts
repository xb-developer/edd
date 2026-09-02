import { Router } from "express";
import { withOrgSession, initMatterGuidCounter, recordAuditEvent } from "@xbundle/edd-workbench-core";
import { requireRole, requireMatterAccess } from "../auth.js";

export const mattersRouter = Router();

interface MatterDTO {
  id: string;
  name: string;
  referenceCode: string | null;
  status: string;
  createdBy: string | null;
  createdAt: string;
}

function toMatterDTO(row: {
  id: string;
  name: string;
  reference_code: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
}): MatterDTO {
  return {
    id: row.id,
    name: row.name,
    referenceCode: row.reference_code,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

mattersRouter.get("/", async (req, res, next) => {
  try {
    const { orgId, userId, role } = req.eddContext!;
    // Admins see every matter in the org, unfiltered; everyone else only
    // sees matters they've actually been granted access to (matter_members)
    // — matches requireMatterAccess's own admin-bypass rule for every other
    // matter-scoped route, so the dropdown never lists a matter a user
    // would immediately get a 403 from opening.
    const matters =
      role === "admin"
        ? await withOrgSession(orgId, (client) => client.query("SELECT * FROM matters WHERE org_id = $1 ORDER BY created_at DESC", [orgId]))
        : await withOrgSession(orgId, (client) =>
            client.query(
              `SELECT * FROM matters
               WHERE org_id = $1 AND EXISTS (SELECT 1 FROM matter_members WHERE matter_id = matters.id AND user_id = $2)
               ORDER BY created_at DESC`,
              [orgId, userId],
            ),
          );
    res.json(matters.rows.map(toMatterDTO));
  } catch (err) {
    next(err);
  }
});

// Litigation support is "admin-lite" (build plan §7): can create/manage
// matters, just not apply reviewer-level tags — enforced here, not just in
// the client UI.
mattersRouter.post("/", requireRole("admin", "litigation_support"), async (req, res, next) => {
  try {
    const { orgId, userId, role } = req.eddContext!;
    const { name, referenceCode } = req.body as { name?: string; referenceCode?: string };
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const matter = await withOrgSession(orgId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO matters (org_id, name, reference_code, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [orgId, name, referenceCode ?? null, userId],
      );
      const row = inserted.rows[0];
      // Counter row created in the same transaction as the matter itself —
      // see build plan §2, matter_guid_counters comment.
      await initMatterGuidCounter(client, row.id);

      // The creator is auto-added to the matter's own access list — UNLESS
      // they're an admin, since admins bypass matter_members entirely and
      // are never a row in it (see requireMatterAccess).
      if (role !== "admin") {
        await client.query("INSERT INTO matter_members (matter_id, user_id, org_id, added_by) VALUES ($1, $2, $3, $2)", [row.id, userId, orgId]);
      }

      await recordAuditEvent(client, {
        orgId,
        actorUserId: userId,
        matterId: row.id,
        action: "matter.create",
        description: `Created matter "${row.name}"`,
      });

      // Seeds the same two built-in tag sets migration 013/014's own
      // backfill gave every pre-existing matter, kept in sync deliberately
      // (a test asserts they match) so a brand-new matter looks identical
      // to one that existed before the coding backend shipped.
      const privilege = await client.query<{ id: string }>(
        "INSERT INTO tag_sets (org_id, matter_id, name, position) VALUES ($1, $2, 'Privilege', 0) RETURNING id",
        [orgId, row.id],
      );
      await client.query(
        `INSERT INTO tags (org_id, matter_id, tag_set_id, name, color, position) VALUES
         ($1, $2, $3, 'Privileged', '#A6362C', 0), ($1, $2, $3, 'Work Product', '#B4551F', 1)`,
        [orgId, row.id, privilege.rows[0].id],
      );
      const review = await client.query<{ id: string }>(
        "INSERT INTO tag_sets (org_id, matter_id, name, position) VALUES ($1, $2, 'Review', 1) RETURNING id",
        [orgId, row.id],
      );
      await client.query(
        `INSERT INTO tags (org_id, matter_id, tag_set_id, name, color, position) VALUES
         ($1, $2, $3, 'Responsive', '#3F7D2C', 0), ($1, $2, $3, 'Not Responsive', NULL, 1), ($1, $2, $3, 'Hot Doc', '#B03362', 2)`,
        [orgId, row.id, review.rows[0].id],
      );

      return row;
    });

    res.status(201).json(toMatterDTO(matter));
  } catch (err) {
    next(err);
  }
});

// Rename only, for now — status/referenceCode changes aren't part of any
// current UI flow, so the body is deliberately narrow rather than a
// generic partial-update. Same role gate as create, PLUS requireMatterAccess
// (this route's own mount is bare "/api/matters", not "/api/matters/:matterId",
// so it isn't already covered by index.ts's shared middleware mount) — a
// litigation_support user shouldn't be able to rename a matter they don't
// personally have access to, only checking role isn't enough on its own.
mattersRouter.patch("/:matterId", requireRole("admin", "litigation_support"), requireMatterAccess(), async (req, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId } = req.params;
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const updated = await withOrgSession(orgId, (client) =>
      client.query("UPDATE matters SET name = $1 WHERE id = $2 AND org_id = $3 RETURNING *", [name.trim(), matterId, orgId]),
    );
    if (updated.rowCount === 0) {
      res.status(404).json({ error: "Matter not found" });
      return;
    }

    res.json(toMatterDTO(updated.rows[0]));
  } catch (err) {
    next(err);
  }
});
