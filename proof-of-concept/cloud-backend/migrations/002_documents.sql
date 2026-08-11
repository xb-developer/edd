-- Phase 2: documents (Secure Document Repository metadata + extraction
-- status), the extraction job queue, and per-matter GUID allocation.

-- Atomic per-matter sequential GUID counter (Bates-style, matching the
-- desktop prototype's numbering scheme — Section 1.1).
ALTER TABLE matters ADD COLUMN next_seq INTEGER NOT NULL DEFAULT 1;

-- Phase 1 had no UPDATE policy on matters at all (no use case yet), so
-- FORCE RLS meant no one — not even the owner — could update a matter row.
-- Uploading now needs to atomically bump next_seq, so group members gain
-- UPDATE, scoped identically to matters_select's group-membership branch.
-- RLS is row-level only, not column-level, so this is paired with an
-- application-level boundary: the only UPDATE statement ever issued against
-- matters by a non-admin caller is the next_seq bump in the upload handler
-- (src/routes/documents.ts) — there is no general "edit matter" endpoint to
-- misuse this policy through.
CREATE POLICY matters_update ON matters FOR UPDATE
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      organization_id = app_uuid('app.current_org_id')
      AND group_id IN (
        SELECT group_id FROM group_members
        WHERE user_id = app_uuid('app.current_user_id')
      )
    )
  );

CREATE TABLE documents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id),
  matter_id            UUID NOT NULL REFERENCES matters(id),
  -- Denormalized from matters, same rationale as group_members/matters
  -- themselves (Section 5.1/5.2): keeps RLS a plain column comparison
  -- instead of a join back to matters on every check.
  group_id             UUID NOT NULL REFERENCES groups(id),
  guid                 TEXT NOT NULL,
  filename             TEXT NOT NULL,
  storage_key          TEXT NOT NULL,
  content_type         TEXT,
  size_bytes           BIGINT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending_extraction',
  extracted_text       TEXT,
  extraction_error     TEXT,
  uploaded_by_user_id  UUID NOT NULL REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (matter_id, guid),
  CONSTRAINT documents_status_check CHECK (status IN ('pending_extraction', 'extracted', 'extraction_failed'))
);
CREATE INDEX idx_documents_matter ON documents(matter_id);
CREATE INDEX idx_documents_org ON documents(organization_id);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

-- Any member of the matter's group can see any document in it, regardless
-- of who uploaded it — this is the whole point of Section 3.3's automatic
-- per-matter repository (no "only the uploader can open it" gap).
CREATE POLICY documents_select ON documents FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      organization_id = app_uuid('app.current_org_id')
      AND group_id IN (
        SELECT group_id FROM group_members
        WHERE user_id = app_uuid('app.current_user_id')
      )
    )
  );

-- Uploading requires being a real member of the matter's group — same
-- discipline as matters_insert in Phase 1, no platform-admin shortcut.
CREATE POLICY documents_insert ON documents FOR INSERT
  WITH CHECK (
    organization_id = app_uuid('app.current_org_id')
    AND uploaded_by_user_id = app_uuid('app.current_user_id')
    AND group_id IN (
      SELECT group_id FROM group_members
      WHERE user_id = app_uuid('app.current_user_id')
    )
  );

-- Only the extraction worker updates a document after upload (status,
-- extracted_text) — it runs under the platform-admin context because it's
-- trusted system code, not acting on behalf of any one tenant user.
CREATE POLICY documents_update ON documents FOR UPDATE
  USING (current_setting('app.is_platform_admin', true) = 'true');

-- Internal extraction queue — deliberately NOT RLS-protected. It is never
-- queried by any tenant-facing route; only the upload handler (enqueue) and
-- the worker (dequeue), both running as trusted system code. Row-level
-- tenant isolation for the underlying documents/matters is still enforced
-- independently wherever this queue's payload is actually acted on.
CREATE TABLE jobs (
  id            BIGSERIAL PRIMARY KEY,
  type          TEXT NOT NULL,
  document_id   UUID NOT NULL REFERENCES documents(id),
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jobs_status_check CHECK (status IN ('pending', 'processing', 'done', 'failed'))
);
CREATE INDEX idx_jobs_pending ON jobs(status, created_at) WHERE status = 'pending';
