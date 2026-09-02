-- Backs the worker-health half of the Processing Status panel (Phase 1):
-- one row per named queue, updated by the worker's own consumeQueue loop
-- (see apps/edd-workbench/worker/src/queues.ts) so a stalled consumer shows
-- up as a frozen last_tick_at rather than silence. Not tenant data — it's
-- one row per queue across the whole process, not per-org — so deliberately
-- NOT row-level-secured, same reasoning as organizations (002_organizations.sql).
CREATE TABLE worker_heartbeat (
  queue_name text PRIMARY KEY,
  last_tick_at timestamptz,
  -- Set when a message handler starts, cleared back to NULL when it
  -- finishes (success or failure) — a non-null value together with its own
  -- age is the "is this consumer stuck on one message" signal, since this
  -- worker processes one message at a time per queue (MaxNumberOfMessages:
  -- 1 in ReceiveMessageCommand), not concurrently.
  processing_started_at timestamptz,
  processed_total bigint NOT NULL DEFAULT 0,
  failed_total bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON worker_heartbeat TO edd_workbench_app;
