-- One row per selectable tag, always inside a tag_set (see 013's comment —
-- "Custom" is just another tag_set, created lazily on first use, not a
-- structurally different flat list). matter_id is denormalized here
-- (rather than requiring a join through tag_sets on every query) and kept
-- honest by the composite FK below, mirroring the same
-- "denormalize + composite-FK-enforced" shape document_tags uses against
-- documents (015_document_tags.sql).
CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL,
  tag_set_id uuid NOT NULL,
  name text NOT NULL,
  color text,
  position int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tag_set_id, matter_id) REFERENCES tag_sets (id, matter_id) ON DELETE CASCADE,
  -- Backs document_tags' composite FK (015_document_tags.sql).
  UNIQUE (id, matter_id)
);

CREATE INDEX tags_tag_set_id_idx ON tags (tag_set_id, position);

-- Case-insensitive: "privileged" and "Privileged" must not both exist —
-- custom-code creation (tags.ts) does a find-or-create by this same
-- lower(name) rule, so a user retyping an existing code (any casing)
-- reuses it instead of creating a near-duplicate. A plain table UNIQUE
-- constraint only accepts column references, not expressions like
-- lower(name) — this needs a real expression index instead; ON CONFLICT
-- (matter_id, lower(name)) below matches against it by expression, not by
-- a constraint name.
CREATE UNIQUE INDEX tags_matter_id_lower_name_idx ON tags (matter_id, lower(name));

-- Backfill the actual built-in tags for every matter's freshly-seeded
-- Privilege/Review sets — same ordering rationale as 013's own backfill
-- (before ENABLE/FORCE ROW LEVEL SECURITY below). Colors match
-- packages/edd-workbench-ui/src/api.ts's MOCK_TAG_SETS exactly so this
-- migration changes nothing about how the UI looks, only where the data
-- lives.
INSERT INTO tags (org_id, matter_id, tag_set_id, name, color, position)
SELECT ts.org_id, ts.matter_id, ts.id, v.name, v.color, v.position
FROM tag_sets ts
JOIN (VALUES
  ('Privilege', 'Privileged', '#A6362C', 0),
  ('Privilege', 'Work Product', '#B4551F', 1),
  ('Review', 'Responsive', '#3F7D2C', 0),
  ('Review', 'Not Responsive', NULL, 1),
  ('Review', 'Hot Doc', '#B03362', 2)
) AS v(tag_set_name, name, color, position) ON v.tag_set_name = ts.name
ON CONFLICT (matter_id, lower(name)) DO NOTHING;

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;

CREATE POLICY tags_isolation ON tags
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON tags TO edd_workbench_app;
