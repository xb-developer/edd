-- The low-privilege role every server/worker connection runs as. Migrations
-- themselves run as the RDS master/owner user (which Postgres never subjects
-- to RLS, regardless of policies) — this role is deliberately a *different*,
-- non-owner login so RLS policies actually apply to normal request traffic.
-- Its password is set out-of-band post-migration (deploy step reading from
-- AWS Secrets Manager), never committed here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edd_workbench_app') THEN
    CREATE ROLE edd_workbench_app LOGIN;
  END IF;
END
$$;

CREATE TYPE org_role AS ENUM ('admin', 'reviewer', 'litigation_support');

CREATE TABLE org_memberships (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role org_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX org_memberships_user_id_idx ON org_memberships(user_id);

-- RLS is scoped by `app.current_org_id`, a per-transaction session variable
-- the API sets via `SET LOCAL` immediately after resolving the caller's org
-- from their validated JWT (see edd-workbench-core/src/session.ts) — so by
-- the time any query against this table runs, the org is already known and
-- trusted, never taken from request input.
ALTER TABLE org_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY org_memberships_isolation ON org_memberships
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON org_memberships TO edd_workbench_app;

-- Grants for the two tables created before this role existed (002, 003) —
-- neither is RLS-protected (see their own migration files for why), but the
-- app role still needs ordinary privileges on them.
GRANT SELECT, INSERT, UPDATE ON organizations TO edd_workbench_app;
GRANT SELECT, INSERT, UPDATE ON users TO edd_workbench_app;
