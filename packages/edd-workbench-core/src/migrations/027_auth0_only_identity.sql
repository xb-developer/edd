-- Removes the local organizations/users/org_memberships/org_invitations
-- tables entirely — Auth0 becomes the sole source of truth for who exists
-- and what org-role they hold (Auth0 Organizations + Organization-scoped
-- roles, resolved per-request via a cached Management API call — see
-- auth0Management.ts). This followed from a real bug: auth.ts read `email`
-- off the Auth0 access token, but access tokens issued for a custom API
-- audience never carry that claim (only ID tokens do), so every login
-- silently blanked users.email and the entire invite-matching flow could
-- never succeed for anyone without a pre-existing membership row.
--
-- `matter_members` stays — Auth0 has no concept of "matters" — but its
-- user_id/added_by/org_id columns switch from local uuids to the raw
-- Auth0 user/org ID strings, matching every other tenant-scoped table
-- below.
--
-- Clean reset, not a data migration: staging's existing rows can't be
-- translated from local uuids to Auth0 IDs without a per-row lookup this
-- migration deliberately doesn't attempt (confirmed acceptable — this is
-- disposable staging content, not production data). TRUNCATE ... CASCADE
-- from organizations/users clears every dependent row in one statement,
-- since all nine tenant-scoped tables already have ON DELETE CASCADE (or,
-- for audit_log.actor_user_id, SET NULL — irrelevant once truncated) FKs
-- pointing at one or the other.
TRUNCATE organizations, users CASCADE;

-- Drop every FK that pointed at the local organizations/users tables,
-- before retyping the columns themselves (a column type can't change
-- while a constraint still requires it to match the referenced column's
-- type). Default constraint names for unnamed inline REFERENCES follow
-- Postgres's own `<table>_<column>_fkey` convention.
ALTER TABLE matters DROP CONSTRAINT IF EXISTS matters_org_id_fkey;
ALTER TABLE matters DROP CONSTRAINT IF EXISTS matters_created_by_fkey;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_org_id_fkey;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_uploaded_by_fkey;
ALTER TABLE tag_sets DROP CONSTRAINT IF EXISTS tag_sets_org_id_fkey;
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_org_id_fkey;
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_created_by_fkey;
ALTER TABLE document_tags DROP CONSTRAINT IF EXISTS document_tags_org_id_fkey;
ALTER TABLE document_tags DROP CONSTRAINT IF EXISTS document_tags_applied_by_fkey;
ALTER TABLE matter_exports DROP CONSTRAINT IF EXISTS matter_exports_org_id_fkey;
ALTER TABLE matter_exports DROP CONSTRAINT IF EXISTS matter_exports_requested_by_fkey;
ALTER TABLE matter_members DROP CONSTRAINT IF EXISTS matter_members_org_id_fkey;
ALTER TABLE matter_members DROP CONSTRAINT IF EXISTS matter_members_user_id_fkey;
ALTER TABLE matter_members DROP CONSTRAINT IF EXISTS matter_members_added_by_fkey;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_org_id_fkey;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_user_id_fkey;
ALTER TABLE document_chunks DROP CONSTRAINT IF EXISTS document_chunks_org_id_fkey;

-- Drop every RLS policy that references org_id BEFORE retyping it —
-- Postgres refuses ALTER COLUMN TYPE on a column a policy depends on
-- ("cannot alter type of a column used in a policy definition", a real
-- error hit on the first deploy attempt). Recreated below, after the
-- column types have actually changed.
DROP POLICY matters_isolation ON matters;
DROP POLICY documents_isolation ON documents;
DROP POLICY tag_sets_isolation ON tag_sets;
DROP POLICY tags_isolation ON tags;
DROP POLICY document_tags_isolation ON document_tags;
DROP POLICY matter_exports_isolation ON matter_exports;
DROP POLICY matter_members_isolation ON matter_members;
DROP POLICY audit_log_isolation ON audit_log;
DROP POLICY document_chunks_isolation ON document_chunks;

-- Retype org_id (uuid -> text) on every tenant-scoped table. No `USING`
-- data-preserving cast needed beyond a plain ::text — these are all empty
-- post-truncate, but the cast is included anyway so this statement is
-- correct even if run against a table that somehow still has rows.
ALTER TABLE matters ALTER COLUMN org_id TYPE text USING org_id::text;
ALTER TABLE documents ALTER COLUMN org_id TYPE text USING org_id::text;
ALTER TABLE tag_sets ALTER COLUMN org_id TYPE text USING org_id::text;
ALTER TABLE tags ALTER COLUMN org_id TYPE text USING org_id::text;
ALTER TABLE document_tags ALTER COLUMN org_id TYPE text USING org_id::text;
ALTER TABLE matter_exports ALTER COLUMN org_id TYPE text USING org_id::text;
ALTER TABLE matter_members ALTER COLUMN org_id TYPE text USING org_id::text;
ALTER TABLE audit_log ALTER COLUMN org_id TYPE text USING org_id::text;
ALTER TABLE document_chunks ALTER COLUMN org_id TYPE text USING org_id::text;

-- Retype every *_by/user_id column (uuid -> text). audit_log.actor_user_id
-- loses its ON DELETE SET NULL semantic along with the FK itself — Auth0
-- is now the only source of truth for whether that user still exists, so
-- there's nothing left for a local constraint to enforce.
ALTER TABLE matters ALTER COLUMN created_by TYPE text USING created_by::text;
ALTER TABLE documents ALTER COLUMN uploaded_by TYPE text USING uploaded_by::text;
ALTER TABLE tags ALTER COLUMN created_by TYPE text USING created_by::text;
ALTER TABLE document_tags ALTER COLUMN applied_by TYPE text USING applied_by::text;
ALTER TABLE matter_exports ALTER COLUMN requested_by TYPE text USING requested_by::text;
ALTER TABLE matter_members ALTER COLUMN user_id TYPE text USING user_id::text;
ALTER TABLE matter_members ALTER COLUMN added_by TYPE text USING added_by::text;
ALTER TABLE audit_log ALTER COLUMN actor_user_id TYPE text USING actor_user_id::text;

-- Recreate every RLS policy without the `::uuid` cast (org_id is text now).
CREATE POLICY matters_isolation ON matters
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY documents_isolation ON documents
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY tag_sets_isolation ON tag_sets
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY tags_isolation ON tags
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY document_tags_isolation ON document_tags
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY matter_exports_isolation ON matter_exports
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY matter_members_isolation ON matter_members
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY audit_log_isolation ON audit_log
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY document_chunks_isolation ON document_chunks
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), ''));

-- Drop the obsolete tables themselves (org_memberships/org_invitations
-- first — they're the only remaining referrers of organizations/users).
DROP TABLE org_memberships;
DROP TABLE org_invitations;
DROP TABLE users;
DROP TABLE organizations;
