-- The tenant identity table. Deliberately NOT row-level-secured — a row here
-- is looked up by auth0_org_id (taken from the validated JWT's organization
-- claim) *before* app.current_org_id can be set for the request, so this
-- lookup has to run without an RLS policy in the way. It holds no document
-- data itself, only tenant identity, so that's an acceptable scope for "no
-- RLS" — every table that holds actual tenant data gets RLS (see 004, 005).
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  auth0_org_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
