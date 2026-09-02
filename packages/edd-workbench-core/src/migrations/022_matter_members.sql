-- Real per-matter access control: who may open/act on a specific matter.
-- Deliberately unrelated to org_memberships — this doesn't mirror org
-- membership, it records a narrower, matter-specific grant on top of
-- whatever org a `users` row already belongs to. Admins bypass this table
-- entirely (see requireMatterAccess) and are never a row here.
CREATE TABLE matter_members (
  matter_id uuid NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Denormalized (matter_id alone already implies org via FK) so RLS can
  -- filter directly without a join — same precedent as tag_sets/matter_exports.
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (matter_id, user_id)
);

CREATE INDEX matter_members_user_id_idx ON matter_members(user_id);

ALTER TABLE matter_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_members FORCE ROW LEVEL SECURITY;

CREATE POLICY matter_members_isolation ON matter_members
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON matter_members TO edd_workbench_app;

-- One-time backfill: enforcement (requireMatterAccess) goes live the moment
-- this migration runs, so every existing matter's own creator must already
-- be a member — otherwise a matter's creator would find themselves locked
-- out of their own matter the instant this ships.
INSERT INTO matter_members (matter_id, user_id, org_id)
SELECT id, created_by, org_id FROM matters WHERE created_by IS NOT NULL;
