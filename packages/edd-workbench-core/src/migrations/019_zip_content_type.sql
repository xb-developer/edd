-- New zip container support (see ingest.ts's handleZipIngest) needs its own
-- content_type_detected value, same precedent as every other format added
-- to this enum since migration 009.
ALTER TYPE document_content_type ADD VALUE 'zip';
