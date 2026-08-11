-- Phase 4: text chunks + embeddings for the RAG assistant. No pgvector —
-- this machine can't compile it (needs MSVC build tools), and the desktop
-- prototype already proved brute-force cosine similarity in JS is plenty
-- fast at this corpus scale (Section 3.4/8.2 leaves the vector store choice
-- open; pgvector-on-RDS is a straightforward production follow-up since RDS
-- doesn't need local compilation). embedding is a plain REAL[] column.

CREATE TABLE chunks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  matter_id        UUID NOT NULL REFERENCES matters(id),
  -- Denormalized from documents, same rationale as everywhere else in this
  -- schema — RLS is a plain column comparison, no join needed on every check.
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  group_id         UUID NOT NULL REFERENCES groups(id),
  chunk_index      INTEGER NOT NULL,
  text             TEXT NOT NULL,
  embedding        REAL[] NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX idx_chunks_matter ON chunks(matter_id);

ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks FORCE ROW LEVEL SECURITY;

-- Same group-membership rule as documents_select — a chunk is exactly as
-- visible as the document it came from, never more or less.
CREATE POLICY chunks_select ON chunks FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      organization_id = app_uuid('app.current_org_id')
      AND group_id IN (SELECT group_id FROM group_members WHERE user_id = app_uuid('app.current_user_id'))
    )
  );

-- Only the embedding worker writes chunks, running as trusted system code
-- (same pattern as documents_update for the extraction worker) — no
-- end-user request path ever inserts a chunk directly.
CREATE POLICY chunks_insert ON chunks FOR INSERT
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
