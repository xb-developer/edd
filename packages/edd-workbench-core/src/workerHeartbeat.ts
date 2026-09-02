import { pool } from "./pool.js";

/**
 * Upserts `queueName`'s row and bumps `last_tick_at` — called once per
 * consumeQueue loop iteration, whether or not a message was actually
 * received, so a frozen `last_tick_at` reliably means "this consumer
 * stopped ticking," not just "it's been idle."
 */
export async function recordTick(queueName: string): Promise<void> {
  await pool.query(
    `INSERT INTO worker_heartbeat (queue_name, last_tick_at, updated_at)
     VALUES ($1, now(), now())
     ON CONFLICT (queue_name) DO UPDATE SET last_tick_at = now(), updated_at = now()`,
    [queueName],
  );
}

/** Marks `queueName` as actively handling a message — cleared by recordProcessingResult. */
export async function recordProcessingStart(queueName: string): Promise<void> {
  await pool.query(
    "UPDATE worker_heartbeat SET processing_started_at = now(), updated_at = now() WHERE queue_name = $1",
    [queueName],
  );
}

/** Clears the in-progress marker and bumps the relevant lifetime counter. */
export async function recordProcessingResult(queueName: string, success: boolean): Promise<void> {
  await pool.query(
    `UPDATE worker_heartbeat
     SET processing_started_at = NULL,
         processed_total = processed_total + CASE WHEN $2 THEN 1 ELSE 0 END,
         failed_total = failed_total + CASE WHEN $2 THEN 0 ELSE 1 END,
         updated_at = now()
     WHERE queue_name = $1`,
    [queueName, success],
  );
}

export interface WorkerHeartbeat {
  queueName: string;
  lastTickAt: string | null;
  processingStartedAt: string | null;
  processedTotal: number;
  failedTotal: number;
}

/** All known queues' heartbeat rows — the DB half of the Processing Status panel's worker-health data; live queue depth comes from SQS directly, not this table. */
export async function getWorkerHeartbeats(): Promise<WorkerHeartbeat[]> {
  const { rows } = await pool.query<{
    queue_name: string;
    last_tick_at: Date | null;
    processing_started_at: Date | null;
    processed_total: string;
    failed_total: string;
  }>("SELECT queue_name, last_tick_at, processing_started_at, processed_total, failed_total FROM worker_heartbeat");
  return rows.map((r) => ({
    queueName: r.queue_name,
    lastTickAt: r.last_tick_at?.toISOString() ?? null,
    processingStartedAt: r.processing_started_at?.toISOString() ?? null,
    processedTotal: Number(r.processed_total),
    failedTotal: Number(r.failed_total),
  }));
}
