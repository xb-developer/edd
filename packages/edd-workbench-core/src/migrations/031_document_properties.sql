-- New per-document properties for the results table:
--
-- content_modified_at: the source document's OWN internal last-modified
-- metadata property (docx/pptx/xlsx's docProps/core.xml dcterms:modified,
-- odt/ods/odp/epub/rtf/html's officeparser-reported modified date) —
-- deliberately separate from file_modified_at (the uploaded file's
-- browser-reported File.lastModified, see that column's own comment) since
-- those are two genuinely different timestamps that can disagree (e.g. a
-- document re-saved under a new filename keeps its own internal modified
-- date from before the rename). Null wherever the property isn't available
-- for a format (email has no "modified" concept beyond doc_date's own Date
-- header; legacy .doc/pdf/image/tiff/text/other have no metadata
-- extraction pipeline for this at all today).
--
-- to_addresses/cc_addresses: promoted out of metadata (where eml/msg's
-- to/cc already lived, alongside bodyText/bodyHtml/attachmentFilenames)
-- into real columns, same "hot results-table field, not buried in
-- metadata" reason title/author/subject/doc_date already are real columns
-- per migration 009's own comment.
ALTER TABLE documents
  ADD COLUMN content_modified_at timestamptz,
  ADD COLUMN to_addresses text,
  ADD COLUMN cc_addresses text;
