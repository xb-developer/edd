-- One-time data correction, not a schema change (same precedent as 022's
-- own backfill INSERT). The staging org's auth0_org_id was left over from
-- before this Auth0 tenant had Organizations enabled at all — a
-- placeholder string, never a real Auth0-generated Organization id — so
-- the matter-access "candidates" dropdown's GET /organizations/{id}/members
-- call 400'd (Auth0 requires the real org_... id, not an arbitrary string).
-- Idempotent: only touches the row that still has the known-wrong
-- placeholder value, a no-op if already corrected or absent.
UPDATE organizations SET auth0_org_id = 'org_iP9hWmPjDgE2GhBv' WHERE auth0_org_id = 'xbundle-staging';
