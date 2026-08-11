-- Fixes a real conflation bug: "Family GUID" (documents.ts's toDocumentDTO)
-- was computed via a single self-LEFT-JOIN on parent_document_id — a
-- one-level-up "parent" value, not a genuine "family" value. At depth 1
-- (an email's direct attachment) that happens to agree with a true family
-- root, which is exactly why it went unnoticed; at depth 2+ (a PST
-- message's own attachment) it changes at every level instead of staying
-- fixed for the whole tree. The Electron POC this app is modeled on keeps
-- family_id/parent_guid/depth as three separate columns (its own db.ts) —
-- family_id set once at the root and inherited unchanged by every
-- descendant, parent_guid reset to the current node's own guid at each
-- level. parent_document_id (011_document_families.sql) was already the
-- correct "direct parent" column — only the derived "family" value
-- downstream was wrong. This adds the real, stored, root-based value.
ALTER TABLE documents ADD COLUMN family_document_id uuid REFERENCES documents(id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN depth int;

-- Backfill every existing row from its parent chain — a top-level document
-- is the root of its own family (family_document_id = its own id, depth
-- 0); every descendant inherits its family_document_id unchanged from its
-- parent and increments depth by one, no matter how deep the chain goes.
WITH RECURSIVE family_tree AS (
  SELECT id, id AS family_document_id, 0 AS depth
  FROM documents WHERE parent_document_id IS NULL
  UNION ALL
  SELECT d.id, ft.family_document_id, ft.depth + 1
  FROM documents d JOIN family_tree ft ON d.parent_document_id = ft.id
)
UPDATE documents d SET family_document_id = ft.family_document_id, depth = ft.depth
FROM family_tree ft WHERE d.id = ft.id;

-- NOT NULL: a childless document's family root is itself — matches the
-- same "always has a value" rule already established for the DTO's
-- familyGuid field, and keeps every read query free of COALESCE.
ALTER TABLE documents ALTER COLUMN family_document_id SET NOT NULL;
ALTER TABLE documents ALTER COLUMN depth SET NOT NULL;
ALTER TABLE documents ALTER COLUMN depth SET DEFAULT 0;

CREATE INDEX documents_family_document_id_idx ON documents (family_document_id);
