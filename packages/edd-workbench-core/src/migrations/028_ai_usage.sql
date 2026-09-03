-- Per-user, per-call-site running token totals for the self-hosted AI
-- services (embedding + generation) — there's no external per-token bill
-- to reconcile against on a self-hosted GPU, so this is a live running
-- counter for capacity-planning/usage visibility, not an event ledger.
-- One row per (org, user, call_site); recording is a plain increment, not
-- an INSERT-per-request.
CREATE TABLE ai_usage (
  org_id text NOT NULL,
  user_id text NOT NULL,
  -- 'embedding' — document ingest (worker's embedding.ts handler)
  -- 'ask' — embedding the user's own question (ask.ts)
  -- 'summarization' — generating the grounded answer (ask.ts)
  call_site text NOT NULL CHECK (call_site IN ('embedding', 'ask', 'summarization')),
  total_tokens bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, call_site)
);

CREATE INDEX ai_usage_org_id_idx ON ai_usage (org_id);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_usage_isolation ON ai_usage
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), ''));

GRANT SELECT, INSERT, UPDATE ON ai_usage TO edd_workbench_app;
