import { Router } from "express";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { getWorkerHeartbeats, sqsClient } from "@xbundle/edd-workbench-core";

// Mounted at /api/worker-status — cross-org infra visibility (queue depth,
// worker liveness), not tenant/matter data, so there's no org/matter scope
// to check here beyond "is this caller an admin." The Processing Status
// panel (client) polls this for its live worker-health bar.
export const workerStatusRouter = Router();

const QUEUES: { name: string; url: string | undefined }[] = [
  { name: "ingest", url: process.env.EDD_WORKBENCH_INGEST_QUEUE_URL },
  { name: "export", url: process.env.EDD_WORKBENCH_EXPORT_QUEUE_URL },
];

workerStatusRouter.get("/", async (req, res, next) => {
  try {
    if (req.eddContext!.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    const [heartbeats, approximateMessages] = await Promise.all([
      getWorkerHeartbeats(),
      Promise.all(
        QUEUES.map(async ({ name, url }) => {
          if (!url) return [name, null] as const;
          const { Attributes } = await sqsClient.send(
            new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages"] }),
          );
          const raw = Attributes?.ApproximateNumberOfMessages;
          return [name, raw !== undefined ? Number(raw) : null] as const;
        }),
      ),
    ]);
    const depthByName = new Map(approximateMessages);

    res.json({
      queues: QUEUES.map(({ name }) => ({
        name,
        heartbeat: heartbeats.find((h) => h.queueName === name) ?? null,
        approximateMessages: depthByName.get(name) ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});
