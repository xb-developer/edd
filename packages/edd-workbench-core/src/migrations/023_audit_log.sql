-- Append-only action trail. ON DELETE SET NULL (not CASCADE) on every
-- reference below — an audit trail must outlive the thing it describes;
-- `description` is rendered at write time specifically so a row stays
-- meaningful even after its matter/document/actor is later gone.
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  matter_id uuid REFERENCES matters(id) ON DELETE SET NULL,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  -- A plain string, not a DB enum — see auditLog.ts's AuditAction union. A
  -- future action not yet thought of is just one more union member, no
  -- migration required.
  action text NOT NULL,
  description text NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_org_id_created_at_idx ON audit_log (org_id, created_at DESC);
CREATE INDEX audit_log_matter_id_idx ON audit_log (matter_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_isolation ON audit_log
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Append-only: no UPDATE/DELETE grant at all.
GRANT SELECT, INSERT ON audit_log TO edd_workbench_app;
