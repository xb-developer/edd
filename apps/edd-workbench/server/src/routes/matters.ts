import { Router } from "express";
import { withOrgSession, initMatterGuidCounter } from "@xbundle/edd-workbench-core";
import { requireRole } from "../auth.js";

export const mattersRouter = Router();

interface MatterDTO {
  id: string;
  name: string;
  referenceCode: string | null;
  status: string;
  createdAt: string;
}

function toMatterDTO(row: {
  id: string;
  name: string;
  reference_code: string | null;
  status: string;
  created_at: string;
}): MatterDTO {
  return {
    id: row.id,
    name: row.name,
    referenceCode: row.reference_code,
    status: row.status,
    createdAt: row.created_at,
  };
}

mattersRouter.get("/", async (req, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const matters = await withOrgSession(orgId, (client) =>
      client.query("SELECT * FROM matters WHERE org_id = $1 ORDER BY created_at DESC", [orgId]),
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
    const { orgId, userId } = req.eddContext!;
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
