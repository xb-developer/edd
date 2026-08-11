-- Outlook PST/OST support (see ingest.ts's pst branch and
-- extractors/pst.ts). A message *inside* a PST was never itself separately
-- uploaded — pst-extractor exposes decoded properties and attachment byte
-- streams, never a reconstructable original MIME blob for the message
-- itself, so synthesizing one would be a lossy, invented artifact presented
-- as if it were original evidence. Child message rows are therefore
-- metadata-only, same "extract once, render from metadata" model eml/msg/
-- docx already use (see migration 009/010's content_type_detected
-- comments), just with no backing S3 object at all rather than one reused
-- for view-url.
ALTER TYPE document_content_type ADD VALUE 'pst';

-- Nullable now that a PST-internal message document has no original file to
-- point at. documents.ts's GET /:id/view-url is updated alongside this
-- migration to explicitly check for a null s3_key and return 409 rather
-- than letting an unhandled S3 client error surface as a 500.
ALTER TABLE documents ALTER COLUMN s3_key DROP NOT NULL;
