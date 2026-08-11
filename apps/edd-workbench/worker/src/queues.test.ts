import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CreateQueueCommand, SendMessageCommand, PurgeQueueCommand } from "@aws-sdk/client-sqs";
import { sqsClient } from "@xbundle/edd-workbench-core";
import { consumeQueue } from "./queues.js";

const QUEUE_URL = "http://localhost:9324/queue/edd-workbench-queues-unit-test";

describe("consumeQueue", () => {
  it("stops and resolves cleanly when its AbortSignal fires, rather than looping forever", async () => {
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-queues-unit-test" }));
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: QUEUE_URL })).catch(() => {});

    const controller = new AbortController();
    const consumePromise = consumeQueue(QUEUE_URL, async () => {}, controller.signal);

    controller.abort();
    await expect(consumePromise).resolves.toBeUndefined();
  });

  it("processes a real message (via the shared, MinIO/ElasticMQ-aware sqsClient — not an unconfigured client of its own) before stopping", async () => {
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-queues-unit-test" }));
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: QUEUE_URL })).catch(() => {});

    const marker = randomUUID();
    await sqsClient.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: marker }));

    const handled: string[] = [];
    const controller = new AbortController();
    const consumePromise = consumeQueue(
      QUEUE_URL,
      async (body) => {
        handled.push(body);
        controller.abort(); // stop after the first message, rather than looping forever in a test
      },
      controller.signal,
    );

    await consumePromise;
    expect(handled).toEqual([marker]);
  });
});
