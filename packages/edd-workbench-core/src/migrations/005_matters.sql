CREATE TABLE matters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  reference_code text,
  status text NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX matters_org_id_idx ON matters(org_id);

ALTER TABLE matters ENABLE ROW LEVEL SECURITY;
ALTER TABLE matters FORCE ROW LEVEL SECURITY;

CREATE POLICY matters_isolation ON matters
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON matters TO edd_workbench_app;

-- One counter row per matter, inserted by the application in the same
-- transaction as the matter itself (see edd-workbench-core/src/guidCounter.ts)
-- so the counter's UPDATE ... RETURNING always has a row to lock — never
-- created lazily on first document import.
CREATE TABLE matter_guid_counters (
  matter_id uuid PRIMARY KEY REFERENCES matters(id) ON DELETE CASCADE,
  next_value bigint NOT NULL DEFAULT 1
);

-- No separate org_id column here — every access goes through matter_id,
-- and matter_id already implies an org via `matters`, so RLS is enforced by
-- joining rather than by a policy on this table directly. This table is only
-- ever touched via nextMatterGuid() (see guidCounter.ts), never queried
-- ad hoc, so a direct policy would add complexity with no read path to
-- protect.
GRANT SELECT, INSERT, UPDATE ON matter_guid_counters TO edd_workbench_app;
