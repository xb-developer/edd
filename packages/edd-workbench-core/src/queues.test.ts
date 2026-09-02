import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CreateQueueCommand, SendMessageCommand, PurgeQueueCommand } from "@aws-sdk/client-sqs";
import { sqsClient } from "./sqs.js";
import { getWorkerHeartbeats } from "./workerHeartbeat.js";
import { consumeQueue } from "./queues.js";

const QUEUE_URL = "http://localhost:9324/queue/edd-workbench-queues-unit-test";

describe("consumeQueue", () => {
  it("stops and resolves cleanly when its AbortSignal fires, rather than looping forever", async () => {
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-queues-unit-test" }));
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: QUEUE_URL })).catch(() => {});

    const controller = new AbortController();
    const consumePromise = consumeQueue(QUEUE_URL, "queues-unit-test", async () => {}, controller.signal);

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
      "queues-unit-test",
      async (body) => {
        handled.push(body);
        controller.abort(); // stop after the first message, rather than looping forever in a test
      },
      controller.signal,
    );

    await consumePromise;
    expect(handled).toEqual([marker]);
  });

  it("records a heartbeat tick even when no message is ever received", async () => {
    const queueName = `heartbeat-idle-${randomUUID()}`;
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-queues-unit-test" }));
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: QUEUE_URL })).catch(() => {});

    const controller = new AbortController();
    const consumePromise = consumeQueue(QUEUE_URL, queueName, async () => {}, controller.signal);
    controller.abort();
    await consumePromise;

    const heartbeats = await getWorkerHeartbeats();
    const own = heartbeats.find((h) => h.queueName === queueName);
    expect(own?.lastTickAt).not.toBeNull();
    expect(own?.processingStartedAt).toBeNull();
    expect(own?.processedTotal).toBe(0);
    expect(own?.failedTotal).toBe(0);
  });

  it("clears the in-progress marker and bumps processed_total after a successful message", async () => {
    const queueName = `heartbeat-success-${randomUUID()}`;
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-queues-unit-test" }));
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: QUEUE_URL })).catch(() => {});
    await sqsClient.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: randomUUID() }));

    const controller = new AbortController();
    await consumeQueue(
      QUEUE_URL,
      queueName,
      async () => {
        controller.abort();
      },
      controller.signal,
    );

    const heartbeats = await getWorkerHeartbeats();
    const own = heartbeats.find((h) => h.queueName === queueName);
    expect(own?.processingStartedAt).toBeNull();
    expect(own?.processedTotal).toBe(1);
    expect(own?.failedTotal).toBe(0);
  });

  it("clears the in-progress marker and bumps failed_total when the handler throws", async () => {
    const queueName = `heartbeat-failure-${randomUUID()}`;
    await sqsClient.send(new CreateQueueCommand({ QueueName: "edd-workbench-queues-unit-test" }));
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: QUEUE_URL })).catch(() => {});
    await sqsClient.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: randomUUID() }));

    const controller = new AbortController();
    await consumeQueue(
      QUEUE_URL,
      queueName,
      async () => {
        controller.abort();
        throw new Error("simulated handler failure");
      },
      controller.signal,
    );

    const heartbeats = await getWorkerHeartbeats();
    const own = heartbeats.find((h) => h.queueName === queueName);
    expect(own?.processingStartedAt).toBeNull();
    expect(own?.processedTotal).toBe(0);
    expect(own?.failedTotal).toBe(1);
  });
});
