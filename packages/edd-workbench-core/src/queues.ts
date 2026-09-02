import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { sqsClient } from "./sqs.js";
import { recordTick, recordProcessingStart, recordProcessingResult } from "./workerHeartbeat.js";

// Heartbeat writes are a diagnostic side-channel for the Processing Status
// panel, not part of the actual queue-processing contract — a DB hiccup
// here must never crash or stall real message handling, so every call is
// swallowed (logged, not thrown) rather than left to propagate.
async function tryHeartbeat(fn: () => Promise<void>, what: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`Heartbeat: failed to ${what}:`, err);
  }
}

/**
 * Long-polls one queue until `signal` is aborted, handing each message body
 * to `handle` and deleting it only after `handle` resolves — an unhandled
 * throw leaves the message on the queue to retry (and eventually land in
 * its DLQ after 5 attempts, per the build plan §1), rather than being
 * silently dropped. Uses the shared sqsClient (MinIO/ElasticMQ-aware in
 * local dev via SQS_ENDPOINT — see edd-workbench-core/src/sqs.ts), not an
 * unconfigured client of its own.
 *
 * Accepting an AbortSignal isn't test-only scaffolding: a consumer that can
 * only be stopped with SIGKILL is a real gap for graceful shutdown (e.g.
 * ECS deploys/scale-downs) — this is a genuine production improvement the
 * need to test this loop surfaced, not a workaround.
 *
 * `queueName` is a short logical label ("ingest", "export", "ocr") — a
 * separate identifier from `queueUrl` because the Processing Status panel
 * wants a stable key regardless of the real queue's URL/ARN.
 *
 * Lives in core (not the worker app) because more than one service now
 * consumes queues this way — the worker (ingest/export) and the OCR
 * service — and both want the exact same heartbeat/shutdown/retry
 * semantics, not two copies that can drift.
 */
export async function consumeQueue(
  queueUrl: string,
  queueName: string,
  handle: (body: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    await tryHeartbeat(() => recordTick(queueName), `record tick for ${queueName}`);

    let Messages;
    try {
      ({ Messages } = await sqsClient.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20 }),
        { abortSignal: signal },
      ));
    } catch (err) {
      if (signal?.aborted) return; // aborting mid-poll rejects the in-flight request — expected, not an error
      throw err;
    }

    for (const message of Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) continue;
      await tryHeartbeat(() => recordProcessingStart(queueName), `record processing start for ${queueName}`);
      try {
        await handle(message.Body);
        await sqsClient.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
        await tryHeartbeat(() => recordProcessingResult(queueName, true), `record success for ${queueName}`);
      } catch (err) {
        console.error(`Failed to process message from ${queueUrl}:`, err);
        await tryHeartbeat(() => recordProcessingResult(queueName, false), `record failure for ${queueName}`);
      }
    }
  }
}
