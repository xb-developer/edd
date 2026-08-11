CREATE TYPE document_content_type AS ENUM ('docx', 'xlsx', 'pptx', 'eml', 'msg', 'pdf', 'image', 'text', 'other');
CREATE TYPE document_ingest_status AS ENUM ('pending', 'processing', 'ready', 'failed');

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  -- Numeric, not the zero-padded display string — sort/compare as a number,
  -- format via formatGuid() only at display time (see guidCounter.ts).
  guid_number int NOT NULL,
  original_filename text NOT NULL,
  extension text NOT NULL,
  size_bytes bigint NOT NULL,
  file_modified_at timestamptz,
  s3_key text NOT NULL,
  content_type_detected document_content_type NOT NULL,
  ingest_status document_ingest_status NOT NULL DEFAULT 'pending',
  ingest_error text,
  -- Cross-type fields promoted to real columns (not buried in metadata) so
  -- the results-table's hot sort/filter path never needs `metadata->>'x'`.
  title text,
  author text,
  subject text,
  doc_date timestamptz,
  -- Type-specific extras only: eml/msg's from/to/cc/attachments, office
  -- docProps not promoted above. Never sorted/filtered on directly.
  metadata jsonb,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, guid_number)
);

CREATE INDEX documents_matter_id_idx ON documents (matter_id, guid_number);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

-- NULLIF-guarded from the start (see migration 008's comment for why a
-- plain ::uuid cast on an unset setting throws rather than cleanly
-- evaluating to "no match" on a reused pooled connection).
CREATE POLICY documents_isolation ON documents
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON documents TO edd_workbench_app;
