-- Postgres's custom GUCs are "sticky" per backend connection: once a
-- parameter name has been referenced via SET/set_config at least once on a
-- given connection, current_setting(name, missing_ok=true) returns '' when
-- it's unset *in the current transaction*, not NULL — missing_ok only
-- suppresses the "unrecognized parameter" error for a name the connection
-- has genuinely never seen. Because the server uses a connection POOL (the
-- same backend connection serves many transactions across many requests),
-- a transaction that only sets app.current_user_id/app.current_user_email
-- (withUserIdentitySession) can land on a connection some *other* request
-- previously ran withOrgSession on — meaning app.current_org_id is
-- "recognized" but empty here, and ''::uuid throws "invalid input syntax
-- for type uuid" instead of cleanly evaluating to "doesn't match." This hit
-- in practice: a real login's first request (no org context yet, by
-- design) 500'd on exactly this.
--
-- NULLIF(..., '') converts that empty string to a real NULL before the
-- cast, so an unset org context correctly means "doesn't match" rather than
-- a hard error, on both a fresh connection and a reused one.
DROP POLICY matters_isolation ON matters;
CREATE POLICY matters_isolation ON matters
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY org_memberships_isolation ON org_memberships;
CREATE POLICY org_memberships_isolation ON org_memberships
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

DROP POLICY org_invitations_isolation ON org_invitations;
CREATE POLICY org_invitations_isolation ON org_invitations
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR email = current_setting('app.current_user_email', true)
  );
