-- Separate from document_ingest_status, deliberately — same reasoning as
-- migration 026's document_embedding_status: "did this document ever need
-- OCR, and how did that go" is its own axis from "is ingest done overall".
-- A document can reach ingest_status = 'ready' via a real embedded text
-- layer (or a native docx/eml/etc extractor) just as easily as via OCR —
-- ingest_status alone can't tell those apart after the fact, which is
-- exactly the gap this column closes. 'excluded' is the default for every
-- document whose content type never goes through OCR at all (docx, eml,
-- a pdf with a real text layer, ...), not just "OCR failed"/no rows — see
-- ingest.ts's pdf/image/tiff branch, the only place this ever moves off
-- 'excluded'.
CREATE TYPE document_ocr_status AS ENUM ('excluded', 'processing', 'ready', 'failed');

ALTER TABLE documents ADD COLUMN ocr_status document_ocr_status NOT NULL DEFAULT 'excluded';
