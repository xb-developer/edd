-- Real backend for the two export buttons — replaces api.ts's
-- `exportMatter` stub, which honestly rejected rather than faking success
-- (there's no file to fake). One job row per kind (documents zip or
-- properties CSV), matching the two independently-triggered buttons/two
-- independently-pollable jobs decision in the plan — not one combined job.
CREATE TYPE export_kind AS ENUM ('documents', 'properties');
CREATE TYPE export_status AS ENUM ('pending', 'processing', 'ready', 'failed');

CREATE TABLE matter_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  kind export_kind NOT NULL,
  -- Fixed at creation time, never joined against again — the selection the
  -- user checked at export-request time, not a live query re-evaluated
  -- later. The worker tolerates one of these ids having been deleted
  -- between job creation and export time (exports what still exists).
  document_ids uuid[] NOT NULL,
  status export_status NOT NULL DEFAULT 'pending',
  result_s3_key text,
  error text,
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX matter_exports_matter_id_idx ON matter_exports (matter_id, created_at);

ALTER TABLE matter_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_exports FORCE ROW LEVEL SECURITY;

CREATE POLICY matter_exports_isolation ON matter_exports
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON matter_exports TO edd_workbench_app;
