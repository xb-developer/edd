-- Global identity, not org-scoped — a person can belong to more than one
-- organization (see org_memberships). No RLS: the app only ever looks a row
-- up by the caller's own auth0_user_id (taken from the validated JWT's
-- `sub`), never by an arbitrary id supplied by a request, so there's no
-- cross-tenant read to guard against here the way there is for tenant data.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth0_user_id text NOT NULL UNIQUE,
  email text NOT NULL,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
