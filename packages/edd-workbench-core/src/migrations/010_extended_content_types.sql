-- Extends document_content_type for the broader format coverage the worker's
-- extractors now handle (see doc.ts/officeText.ts/xlsx.ts). Legacy variants
-- that share an existing extractor (xls/xla -> xlsx, docm/dotm/xlsm/xltx ->
-- docx/xlsx) deliberately get no new enum value — same extractor, same
-- bucket. ppt/pps/pot/dwg/mpp deliberately get no new value either: they
-- fold into the existing 'other' bucket (see ingest.ts's comment on why
-- legacy .ppt isn't supported).
ALTER TYPE document_content_type ADD VALUE 'doc';
ALTER TYPE document_content_type ADD VALUE 'rtf';
ALTER TYPE document_content_type ADD VALUE 'odt';
ALTER TYPE document_content_type ADD VALUE 'ods';
ALTER TYPE document_content_type ADD VALUE 'odp';
ALTER TYPE document_content_type ADD VALUE 'epub';
ALTER TYPE document_content_type ADD VALUE 'html';
ALTER TYPE document_content_type ADD VALUE 'csv';
ALTER TYPE document_content_type ADD VALUE 'tiff';
