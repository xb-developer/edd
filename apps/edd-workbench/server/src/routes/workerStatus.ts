import { Router, type Request } from "express";
import { withOrgSession, getWorkerHeartbeats } from "@xbundle/edd-workbench-core";

// Mounted at /api/matters/:matterId/worker-status (behind index.ts's shared
// requireMatterAccess() for the :matterId prefix). `heartbeat` (is the
// worker process ticking, is it mid-message right now) is genuinely
// process-global — there's one worker, not one per tenant, so it's still
// queried with no org/matter scope at all. The queued/ok/failed COUNTS
// used to come from that same process-global source (worker_heartbeat's
// lifetime processed_total/failed_total, plus live SQS queue depth) —
// which meant every matter showed the whole system's numbers, not its own.
// These now come from this matter's own documents/matter_exports rows
// instead, which is real matter-scoped data with a real matter_id column,
// unlike worker_heartbeat (see that table's own migration comment — one
// row per queue name, system-wide, deliberately not tenant data).
// mergeParams — mounted at /api/matters/:matterId/worker-status; without
// it, :matterId from the parent mount path isn't visible on req.params
// inside this router (see documentsRouter's own comment for the same
// gotcha).
export const workerStatusRouter = Router({ mergeParams: true });

const QUEUE_NAMES = ["ingest", "export"] as const;

workerStatusRouter.get("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId } = req.params;

    const [heartbeats, ingestCounts, exportCounts] = await Promise.all([
      getWorkerHeartbeats(),
      withOrgSession(orgId, (client) =>
        client.query<{ ingest_status: string; count: string }>(
          "SELECT ingest_status, COUNT(*) AS count FROM documents WHERE matter_id = $1 GROUP BY ingest_status",
          [matterId],
        ),
      ),
      withOrgSession(orgId, (client) =>
        client.query<{ status: string; count: string }>(
          "SELECT status, COUNT(*) AS count FROM matter_exports WHERE matter_id = $1 GROUP BY status",
          [matterId],
        ),
      ),
    ]);

    // 'pending'/'processing' both read as "still in flight" to a caller —
    // matches document_ingest_status/export_status's own four values
    // (migrations 009/016), not a queue-depth number (which never had a
    // matter dimension to begin with — see this file's own comment above).
    function countsFor(rows: { status: string; count: string }[]): { queued: number; ok: number; failed: number } {
      const byStatus = new Map(rows.map((r) => [r.status, Number(r.count)]));
      return {
        queued: (byStatus.get("pending") ?? 0) + (byStatus.get("processing") ?? 0),
        ok: byStatus.get("ready") ?? 0,
        failed: byStatus.get("failed") ?? 0,
      };
    }

    const ingest = countsFor(ingestCounts.rows.map((r) => ({ status: r.ingest_status, count: r.count })));
    const exportStatus = countsFor(exportCounts.rows);
    const countsByQueue: Record<(typeof QUEUE_NAMES)[number], { queued: number; ok: number; failed: number }> = {
      ingest,
      export: exportStatus,
    };

    res.json({
      queues: QUEUE_NAMES.map((name) => {
        const heartbeat = heartbeats.find((h) => h.queueName === name);
        return {
          name,
          heartbeat: heartbeat ? { queueName: heartbeat.queueName, lastTickAt: heartbeat.lastTickAt, processingStartedAt: heartbeat.processingStartedAt } : null,
          ...countsByQueue[name],
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});
