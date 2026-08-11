import { Router, type Request } from "express";
import { withOrgSession } from "@xbundle/edd-workbench-core";
import { requireRole } from "../auth.js";

// mergeParams — mounted at /api/matters/:matterId/tags (see index.ts).
export const tagsRouter = Router({ mergeParams: true });

interface TagSetRow {
  tag_set_id: string;
  tag_set_name: string;
  tag_set_position: number;
  tag_id: string | null;
  tag_name: string | null;
  color: string | null;
  tag_position: number | null;
}

interface TagSetDTO {
  id: string;
  name: string;
  tags: { id: string; name: string; color?: string }[];
}

// One SELECT, grouped in JS — a tag_set with zero tags still needs to
// appear (hence the LEFT JOIN), filtering out the null tag_id rows that
// produces when building the nested array below.
function groupTagSetRows(rows: TagSetRow[]): TagSetDTO[] {
  const byId = new Map<string, TagSetDTO>();
  const order: string[] = [];
  for (const row of rows) {
    if (!byId.has(row.tag_set_id)) {
      byId.set(row.tag_set_id, { id: row.tag_set_id, name: row.tag_set_name, tags: [] });
      order.push(row.tag_set_id);
    }
    if (row.tag_id) {
      byId.get(row.tag_set_id)!.tags.push({ id: row.tag_id, name: row.tag_name!, color: row.color ?? undefined });
    }
  }
  return order.map((id) => byId.get(id)!);
}

// No role gate — litigation_support still needs to see coding state to do
// its own job, it just can't create/apply codes (see requireRole below).
tagsRouter.get("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId } = req.params;

    const rows = await withOrgSession(orgId, (client) =>
      client.query<TagSetRow>(
        `SELECT ts.id AS tag_set_id, ts.name AS tag_set_name, ts.position AS tag_set_position,
                t.id AS tag_id, t.name AS tag_name, t.color, t.position AS tag_position
         FROM tag_sets ts
         LEFT JOIN tags t ON t.tag_set_id = ts.id
         WHERE ts.matter_id = $1
         ORDER BY ts.position, t.position`,
        [matterId],
      ),
    );

    res.json(groupTagSetRows(rows.rows));
  } catch (err) {
    next(err);
  }
});

// requireRole("admin", "reviewer") — matters.ts's own comment on its
// litigation_support grant already states the intended split ("can
// create/manage matters, just not apply reviewer-level tags"); this is the
// first place that intent is actually enforced, since the coding backend
// didn't exist before now.
tagsRouter.post("/custom", requireRole("admin", "reviewer"), async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { matterId } = req.params;
    const name = ((req.body as { name?: string })?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const tag = await withOrgSession(orgId, async (client) => {
      // Find-or-create by case-insensitive name across the WHOLE matter
      // (not just a "Custom" set) — a user retyping an existing code (any
      // casing, any set) reuses it rather than creating a near-duplicate.
      // See 014_tags.sql's expression unique index.
      const existing = await client.query(
        "SELECT id, name, color FROM tags WHERE matter_id = $1 AND lower(name) = lower($2)",
        [matterId, name],
      );
      if (existing.rowCount! > 0) return existing.rows[0];

      // DO NOTHING + a fallback SELECT, not DO UPDATE — the tag_sets role
      // grant is deliberately SELECT/INSERT only (see 013_tag_sets.sql),
      // and Postgres requires UPDATE privilege for a DO UPDATE clause even
      // when it's a genuine no-op.
      const tagSetInsert = await client.query<{ id: string }>(
        `INSERT INTO tag_sets (org_id, matter_id, name, position)
         VALUES ($1, $2, 'Custom', COALESCE((SELECT MAX(position) + 1 FROM tag_sets WHERE matter_id = $2), 0))
         ON CONFLICT (matter_id, name) DO NOTHING
         RETURNING id`,
        [orgId, matterId],
      );
      const tagSetId =
        tagSetInsert.rows[0]?.id ??
        (await client.query<{ id: string }>("SELECT id FROM tag_sets WHERE matter_id = $1 AND name = 'Custom'", [matterId])).rows[0].id;

      const inserted = await client.query(
        `INSERT INTO tags (org_id, matter_id, tag_set_id, name, created_by, position)
         VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT MAX(position) + 1 FROM tags WHERE tag_set_id = $3), 0))
         RETURNING id, name, color`,
        [orgId, matterId, tagSetId, name, userId],
      );
      return inserted.rows[0];
    });

    res.status(201).json({ id: tag.id, name: tag.name, color: tag.color ?? undefined });
  } catch (err) {
    next(err);
  }
});
