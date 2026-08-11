-- Real backend for coding/tagging — replaces packages/edd-workbench-ui's
-- MOCK_TAG_SETS/mockDocumentTags in-memory layer (api.ts). Every tag_sets
-- row is scoped to exactly one matter — no cross-matter/global sets, and
-- that's true for the built-in "Privilege"/"Review" sets too (seeded below
-- per-matter), not just custom ones, so there is exactly one scoping rule
-- to enforce everywhere, matching the "custom code is only available
-- within that Matter" requirement without a special case for built-ins.
CREATE TABLE tag_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Explicit display order — created_at can't reproduce a stable order
  -- here: the seed INSERT below runs inside one transaction, so every
  -- seeded row gets the identical now() value. "Custom" (created lazily,
  -- see tags.ts) always sorts after whatever already exists by computing
  -- its position as MAX(position)+1 at creation time.
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, name),
  -- Backs tags' composite FK (014_tags.sql) so a tag's denormalized
  -- matter_id can never drift from its own tag_set's matter — Postgres
  -- enforces the pairing, not an application-level invariant.
  UNIQUE (id, matter_id)
);

CREATE INDEX tag_sets_matter_id_idx ON tag_sets (matter_id, position);

-- Backfill for every matter that already exists, BEFORE this table's own
-- RLS is enabled below. Deliberate ordering: migrations don't run through
-- withOrgSession, so no app.current_org_id is set here — a policy of
-- `org_id = current_setting(...)::uuid` would reject every row if RLS were
-- already enabled when this runs. Running the backfill first sidesteps the
-- problem entirely.
INSERT INTO tag_sets (org_id, matter_id, name, position)
SELECT m.org_id, m.id, v.name, v.position
FROM matters m
CROSS JOIN (VALUES ('Privilege', 0), ('Review', 1)) AS v(name, position)
ON CONFLICT (matter_id, name) DO NOTHING;

ALTER TABLE tag_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_sets FORCE ROW LEVEL SECURITY;

CREATE POLICY tag_sets_isolation ON tag_sets
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON tag_sets TO edd_workbench_app;
