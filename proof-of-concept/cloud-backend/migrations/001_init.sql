-- Phase 1 control-plane schema: organizations, users, groups, matters.
-- RLS policies are keyed to three per-request session variables the app sets
-- from the verified JWT before running any query (see src/middleware/tenant.ts):
--   app.current_org_id     -- caller's organization id (uuid, or '' if none)
--   app.current_user_id    -- caller's internal user id (uuid, or '' if none)
--   app.is_platform_admin  -- 'true' | 'false'
--
-- These are set with SET LOCAL inside the request's transaction, so they
-- never leak between requests sharing a pooled connection.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth0_org_id   TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth0_user_id    TEXT NOT NULL UNIQUE,
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  email            TEXT NOT NULL,
  display_name     TEXT,
  is_org_admin     BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_org ON users(organization_id);

CREATE TABLE groups (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  name             TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE INDEX idx_groups_org ON groups(organization_id);

-- organization_id is denormalized onto group_members so RLS on this table
-- doesn't need a join/subquery against groups on every check.
CREATE TABLE group_members (
  group_id         UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_members_user ON group_members(user_id);

CREATE TABLE matters (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id),
  group_id           UUID NOT NULL REFERENCES groups(id),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  name               TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_matters_org ON matters(organization_id);
CREATE INDEX idx_matters_group ON matters(group_id);

CREATE TABLE audit_log (
  id               BIGSERIAL PRIMARY KEY,
  organization_id  UUID REFERENCES organizations(id),
  user_id          UUID REFERENCES users(id),
  matter_id        UUID REFERENCES matters(id),
  action           TEXT NOT NULL,
  allowed          BOOLEAN NOT NULL,
  detail           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org ON audit_log(organization_id);

-- ---------- Row-Level Security ----------

-- Safely reads a session-variable uuid: current_setting(...)::uuid throws
-- (rather than evaluating to NULL/false) when the setting is unset or '',
-- and Postgres does not reliably short-circuit that cast out of an
-- `x OR is_platform_admin` policy expression — the isolation test caught
-- this too, on the platform-admin/bootstrap path where current_org_id is
-- deliberately empty. NULLIF(...,'') turns the empty-string case into a
-- normal NULL, which comparisons and casts handle without error.
CREATE FUNCTION app_uuid(setting_name text) RETURNS uuid AS $$
  SELECT NULLIF(current_setting(setting_name, true), '')::uuid
$$ LANGUAGE sql STABLE;

-- FORCE is required in addition to ENABLE: Postgres exempts a table's OWNER
-- from RLS by default, and the app's own role (edd_cloud_backend) owns
-- these tables because it's the role that ran this migration. Without
-- FORCE, every policy below would be silently skipped for every request
-- this backend makes — this is not a hypothetical, it's what the isolation
-- test in test/isolation.test.ts caught on the first run.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE users          FORCE ROW LEVEL SECURITY;
ALTER TABLE groups         ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups         FORCE ROW LEVEL SECURITY;
ALTER TABLE group_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members  FORCE ROW LEVEL SECURITY;
ALTER TABLE matters        ENABLE ROW LEVEL SECURITY;
ALTER TABLE matters        FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log      FORCE ROW LEVEL SECURITY;

-- organizations: a caller can see/touch only their own org, unless they're
-- the platform admin (who provisions new orgs and so must be able to insert
-- a row before any org-scoped session variable could point at it).
CREATE POLICY org_select ON organizations FOR SELECT
  USING (id = app_uuid('app.current_org_id')
         OR current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY org_insert ON organizations FOR INSERT
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY org_update ON organizations FOR UPDATE
  USING (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY users_select ON users FOR SELECT
  USING (organization_id = app_uuid('app.current_org_id')
         OR current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (organization_id = app_uuid('app.current_org_id')
              OR current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY users_update ON users FOR UPDATE
  USING (organization_id = app_uuid('app.current_org_id')
         OR current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY groups_select ON groups FOR SELECT
  USING (organization_id = app_uuid('app.current_org_id')
         OR current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY groups_insert ON groups FOR INSERT
  WITH CHECK (organization_id = app_uuid('app.current_org_id')
              OR current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY groups_update ON groups FOR UPDATE
  USING (organization_id = app_uuid('app.current_org_id')
         OR current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY group_members_select ON group_members FOR SELECT
  USING (organization_id = app_uuid('app.current_org_id')
         OR current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY group_members_insert ON group_members FOR INSERT
  WITH CHECK (organization_id = app_uuid('app.current_org_id')
              OR current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY group_members_delete ON group_members FOR DELETE
  USING (organization_id = app_uuid('app.current_org_id')
         OR current_setting('app.is_platform_admin', true) = 'true');

-- matters: this is the policy that actually encodes "creator or group
-- member only" (deployment doc Section 4.4) at the database layer, as
-- defense-in-depth behind the identical check the application layer makes.
CREATE POLICY matters_select ON matters FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      organization_id = app_uuid('app.current_org_id')
      AND (
        created_by_user_id = app_uuid('app.current_user_id')
        OR group_id IN (
          SELECT group_id FROM group_members
          WHERE user_id = app_uuid('app.current_user_id')
        )
      )
    )
  );
CREATE POLICY matters_insert ON matters FOR INSERT
  WITH CHECK (
    organization_id = app_uuid('app.current_org_id')
    AND created_by_user_id = app_uuid('app.current_user_id')
    AND group_id IN (
      SELECT group_id FROM group_members
      WHERE user_id = app_uuid('app.current_user_id')
    )
  );

CREATE POLICY audit_select ON audit_log FOR SELECT
  USING (organization_id = app_uuid('app.current_org_id')
         OR current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY audit_insert ON audit_log FOR INSERT
  WITH CHECK (organization_id = app_uuid('app.current_org_id')
              OR current_setting('app.is_platform_admin', true) = 'true');
