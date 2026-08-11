-- Bridges the gap between "an admin invites someone" and "that person's
-- users/org_memberships rows exist" — Auth0's own invitation carries no
-- concept of our app-specific role enum, so this table is where the
-- *intended* role waits until the invitee's first login (see auth.ts's
-- resolveOrgContext) creates their users row and consumes the invitation.
CREATE TABLE org_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role org_role NOT NULL,
  invited_by uuid NOT NULL REFERENCES users(id),
  auth0_invitation_id text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz
);

-- Partial (not plain) unique index — only one *pending* invite per
-- email/org at a time, but re-inviting after a prior invite was accepted
-- (or the same person leaves and gets invited again later) must not collide
-- with that old, already-resolved row.
CREATE UNIQUE INDEX org_invitations_pending_unique ON org_invitations (org_id, email) WHERE status = 'pending';
CREATE INDEX org_invitations_org_id_idx ON org_invitations (org_id);

ALTER TABLE org_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY org_invitations_isolation ON org_invitations
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON org_invitations TO edd_workbench_app;
