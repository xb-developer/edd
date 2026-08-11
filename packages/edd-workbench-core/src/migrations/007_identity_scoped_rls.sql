-- Auth0 Organizations turned out to be unavailable on this tenant's Auth0
-- plan, so org context can no longer come from a trusted org_id token
-- claim — the server now has to discover a caller's org(s) itself by
-- looking up org_memberships/org_invitations by identity, which the
-- original org_id-only policies below couldn't allow (there was no org
-- context yet to satisfy them). Widens both with an OR clause: a caller can
-- always see their own rows by identity (app.current_user_id /
-- app.current_user_email, set immediately from the validated JWT — see
-- edd-workbench-core's withUserIdentitySession), in addition to the
-- existing "already has org context established" path used everywhere
-- else. Neither added clause exposes another user's or another org's rows.
DROP POLICY org_memberships_isolation ON org_memberships;
CREATE POLICY org_memberships_isolation ON org_memberships
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    OR user_id = current_setting('app.current_user_id', true)::uuid
  );

DROP POLICY org_invitations_isolation ON org_invitations;
CREATE POLICY org_invitations_isolation ON org_invitations
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    OR email = current_setting('app.current_user_email', true)::text
  );
