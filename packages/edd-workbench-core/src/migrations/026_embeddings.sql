-- RAG Phase 4: self-hosted embeddings (Qwen3-Embedding-8B via vLLM — see
-- infra/edd-workbench/lib/edd-workbench-stack.ts's EmbeddingService). Real
-- RDS Postgres 16 supports `CREATE EXTENSION vector` out of the box; local
-- dev/test uses the pgvector/pgvector:pg16 Docker image as the equivalent
-- (see apps/edd-workbench/docker-compose.yml).
CREATE EXTENSION IF NOT EXISTS vector;

-- Separate from document_ingest_status, deliberately — unlike OCR (which
-- IS the only extraction path for pdf/image/tiff, so it could reuse
-- ingest_status), embedding is a genuine secondary pass over a document
-- that's already 'ready'. 'excluded' is its own state (not just
-- 'failed'/no rows) for content types deliberately never embedded
-- (spreadsheets, pptx, anything with no extracted text at all) — see
-- embeddableText.ts.
CREATE TYPE document_embedding_status AS ENUM ('pending', 'processing', 'ready', 'failed', 'excluded');

ALTER TABLE documents
  ADD COLUMN embedding_status document_embedding_status NOT NULL DEFAULT 'pending',
  ADD COLUMN embedding_error text;

-- 1024 dimensions — Qwen3-Embedding-8B supports Matryoshka-style truncated
-- output (32-4096, requested via the embeddings API's `dimensions` param,
-- see embeddingClient.ts), and pgvector's ANN index types (ivfflat/hnsw)
-- cap out at 2000 dims — 1024 is a well-inside-the-limit, standard
-- middle-ground choice, not a value the model itself requires.
CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  matter_id uuid NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  text text NOT NULL,
  embedding vector(1024) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY;

CREATE POLICY document_chunks_isolation ON document_chunks
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Two separate indexes, not one "composite (matter_id, embedding)" index —
-- pgvector's ANN index types (ivfflat/hnsw) are built on the vector column
-- alone; there is no native multi-column vector+scalar index. A plain
-- btree on matter_id (for the isolation WHERE filter) alongside an hnsw
-- index on embedding (for the similarity search itself) is the standard
-- pattern at this scale.
--
-- CORRECTION (this comment previously claimed "the planner combines
-- them" — it does not, and that claim was wrong): for a filtered
-- similarity search, HNSW finds the rows nearest GLOBALLY and matter_id
-- (plus the RLS org_id predicate) is applied to those candidates
-- afterwards. So a `WHERE matter_id = $1 ORDER BY embedding <=> $2
-- LIMIT n` can return FEWER than n rows — a recall bug, not just a slow
-- query — once more than one matter holds a meaningful share of this
-- table. The runtime fix is pgvector 0.8's iterative scan; see
-- vectorSearch.ts's enableIterativeVectorScan, which ask.ts sets inside
-- the same transaction as the query. The indexes below are unchanged and
-- still correct.
CREATE INDEX document_chunks_matter_id_idx ON document_chunks (matter_id);
CREATE INDEX document_chunks_embedding_hnsw_idx ON document_chunks USING hnsw (embedding vector_cosine_ops);

GRANT SELECT, INSERT, DELETE ON document_chunks TO edd_workbench_app;
