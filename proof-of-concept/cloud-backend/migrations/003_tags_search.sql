-- Phase 3: tags (org-wide vocabulary, matching real review-tool practice —
-- a shared taxonomy like "Privileged"/"Responsive" reused across a firm's
-- matters, not redefined per group), tag application scoped to whoever can
-- see the document, and native Postgres full-text search replacing the
-- desktop prototype's SQLite FTS5.

CREATE TABLE tags (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  name             TEXT NOT NULL,
  color            TEXT,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE INDEX idx_tags_org ON tags(organization_id);

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;

CREATE POLICY tags_select ON tags FOR SELECT
  USING (organization_id = app_uuid('app.current_org_id')
         OR current_setting('app.is_platform_admin', true) = 'true');
-- Any authenticated org member can add to the shared tag vocabulary — this
-- is a working-level action in review tools, not admin-gated.
CREATE POLICY tags_insert ON tags FOR INSERT
  WITH CHECK (organization_id = app_uuid('app.current_org_id')
              AND created_by_user_id = app_uuid('app.current_user_id'));

-- document_tags: denormalized organization_id/group_id from the document
-- (same rationale as documents/group_members) so access mirrors
-- documents_select exactly — any group member who can see a document can
-- see and amend its tags, regardless of who applied them.
CREATE TABLE document_tags (
  document_id         UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id              UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  group_id            UUID NOT NULL REFERENCES groups(id),
  applied_by_user_id  UUID NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, tag_id)
);
CREATE INDEX idx_document_tags_document ON document_tags(document_id);
CREATE INDEX idx_document_tags_tag ON document_tags(tag_id);

ALTER TABLE document_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_tags FORCE ROW LEVEL SECURITY;

CREATE POLICY document_tags_select ON document_tags FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      organization_id = app_uuid('app.current_org_id')
      AND group_id IN (SELECT group_id FROM group_members WHERE user_id = app_uuid('app.current_user_id'))
    )
  );
CREATE POLICY document_tags_insert ON document_tags FOR INSERT
  WITH CHECK (
    organization_id = app_uuid('app.current_org_id')
    AND applied_by_user_id = app_uuid('app.current_user_id')
    AND group_id IN (SELECT group_id FROM group_members WHERE user_id = app_uuid('app.current_user_id'))
  );
-- Any current group member can remove a tag, not only whoever applied it —
-- matches normal collaborative review-coding practice.
CREATE POLICY document_tags_delete ON document_tags FOR DELETE
  USING (
    organization_id = app_uuid('app.current_org_id')
    AND group_id IN (SELECT group_id FROM group_members WHERE user_id = app_uuid('app.current_user_id'))
  );

-- Full-text search: a generated column recomputes automatically whenever
-- extracted_text or filename changes, so the extraction worker doesn't need
-- to separately maintain a search index.
ALTER TABLE documents ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(filename, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(extracted_text, '')), 'B')
  ) STORED;
CREATE INDEX idx_documents_search ON documents USING GIN(search_vector);
