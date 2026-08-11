import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { sqsClient } from "@xbundle/edd-workbench-core";

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
 */
export async function consumeQueue(queueUrl: string, handle: (body: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
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
      try {
        await handle(message.Body);
        await sqsClient.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      } catch (err) {
        console.error(`Failed to process message from ${queueUrl}:`, err);
      }
    }
  }
}
