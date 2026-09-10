-- Groups every document produced by one client-side upload action (one
-- importFiles() call in the browser — see useDocumentImport.ts) under a
-- single id, so the UI can defer showing any of a batch's results until
-- the WHOLE batch (including every child a container's expansion produces
-- later, possibly minutes after the container's own row is uploaded) has
-- left pending/processing. Set explicitly by the client at upload-init
-- time and inherited unchanged by every descendant a container (pst/zip/
-- 7z/mbox) or a real node (eml/msg) expands into — never re-derived
-- per-row, so a matter-wide `GROUP BY upload_batch_id` always reflects one
-- real upload, no matter how deep the resulting tree is.
--
-- NOT NULL with a random default (rather than nullable): every existing
-- row becomes its own one-document "batch" at migration time, which is
-- harmless (nothing queries historical batches) and avoids NULL-handling
-- in every batch-status query going forward.
ALTER TABLE documents ADD COLUMN upload_batch_id uuid NOT NULL DEFAULT gen_random_uuid();

-- Powers the batch-completion check: "does this matter have any
-- pending/processing document left under these batch ids." matter_id
-- leads the index since every query is already matter-scoped (RLS aside).
CREATE INDEX documents_upload_batch_id_idx ON documents (matter_id, upload_batch_id);
