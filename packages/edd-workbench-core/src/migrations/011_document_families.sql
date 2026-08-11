-- Supports the "Family GUID" column: an email/msg's attachments become
-- their own child document rows (own GUID, own extraction/ingest pass),
-- linked back to the message that contained them. ON DELETE CASCADE so
-- deleting a parent message also removes attachments that only make sense
-- in its context, rather than leaving orphaned rows.
ALTER TABLE documents ADD COLUMN parent_document_id uuid REFERENCES documents(id) ON DELETE CASCADE;
CREATE INDEX documents_parent_document_id_idx ON documents (parent_document_id);
