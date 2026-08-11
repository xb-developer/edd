-- Composite-FK target for the join table below — id is already globally
-- unique (PK), so this adds no real constraint on its own, only a
-- (id, matter_id) pair Postgres can point a composite FK at, the same
-- trick 013/014 use for tag_sets/tags.
ALTER TABLE documents ADD CONSTRAINT documents_id_matter_id_unique UNIQUE (id, matter_id);

-- Real join table backing CodingPanel's apply/remove — replaces api.ts's
-- in-memory mockDocumentTags Map. No backfill: that Map only ever lived in
-- the browser's memory, never persisted, so there is nothing to migrate
-- forward.
CREATE TABLE document_tags (
  document_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL,
  applied_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, tag_id),
  -- The actual guard against cross-matter misuse (e.g. applying a Matter B
  -- tag to a Matter A document within the same org — RLS alone only
  -- proves "same org," not "same matter"): a row can only exist if
  -- document_id really belongs to matter_id, and tag_id really belongs to
  -- matter_id. documentTags.ts's route-level pre-check exists for a clean
  -- 400/404 instead of a raw FK-violation 500, not as the only line of
  -- defense.
  FOREIGN KEY (document_id, matter_id) REFERENCES documents (id, matter_id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id, matter_id) REFERENCES tags (id, matter_id) ON DELETE CASCADE
);

CREATE INDEX document_tags_matter_id_idx ON document_tags (matter_id);
CREATE INDEX document_tags_tag_id_idx ON document_tags (tag_id);

ALTER TABLE document_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_tags FORCE ROW LEVEL SECURITY;

CREATE POLICY document_tags_isolation ON document_tags
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON document_tags TO edd_workbench_app;
