import { describe, expect, it } from "vitest";
import { stepIngestWatch, type IngestWatchDocument } from "./ingestWatch.js";

describe("stepIngestWatch", () => {
  it("counts every watched-batch document as ready when the lookup says so, with none still pending", () => {
    const docs: IngestWatchDocument[] = [
      { uploadBatchId: "batch-1", ingestStatus: "ready" },
      { uploadBatchId: "batch-1", ingestStatus: "ready" },
    ];
    const result = stepIngestWatch(docs, new Set(["batch-1"]), 1, 40);
    expect(result).toEqual({ pendingCount: 0, readyCount: 2, failedCount: 0, giveUp: false });
  });

  it("splits a mixed batch into ready/failed/still-pending correctly", () => {
    const docs: IngestWatchDocument[] = [
      { uploadBatchId: "batch-1", ingestStatus: "ready" },
      { uploadBatchId: "batch-1", ingestStatus: "failed" },
      { uploadBatchId: "batch-1", ingestStatus: "pending" },
      { uploadBatchId: "batch-1", ingestStatus: "processing" },
    ];
    const result = stepIngestWatch(docs, new Set(["batch-1"]), 1, 40);
    expect(result.readyCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.pendingCount).toBe(2);
    expect(result.giveUp).toBe(false);
  });

  it("ignores documents outside the watched batch ids entirely", () => {
    const docs: IngestWatchDocument[] = [
      { uploadBatchId: "batch-1", ingestStatus: "pending" },
      { uploadBatchId: "some-other-batch", ingestStatus: "failed" },
    ];
    const result = stepIngestWatch(docs, new Set(["batch-1"]), 1, 40);
    expect(result).toEqual({ pendingCount: 1, readyCount: 0, failedCount: 0, giveUp: false });
  });

  it("a deleted container row (no longer present at all) simply stops counting toward pending — its extracted children, sharing the same batch id, are what's actually still tracked", () => {
    // Simulates the moment right after a fully-successful PST/zip/7z/mbox
    // expansion: the container's own row is gone, but two real extracted
    // children (still pending) and one that's already ready remain.
    const docs: IngestWatchDocument[] = [
      { uploadBatchId: "batch-1", ingestStatus: "pending" },
      { uploadBatchId: "batch-1", ingestStatus: "pending" },
      { uploadBatchId: "batch-1", ingestStatus: "ready" },
    ];
    const result = stepIngestWatch(docs, new Set(["batch-1"]), 1, 40);
    expect(result.pendingCount).toBe(2);
    expect(result.readyCount).toBe(1);
    expect(result.failedCount).toBe(0);
  });

  it("gives up exactly at maxAttempts when documents remain pending", () => {
    const docs: IngestWatchDocument[] = [{ uploadBatchId: "batch-1", ingestStatus: "pending" }];
    const notYet = stepIngestWatch(docs, new Set(["batch-1"]), 39, 40);
    expect(notYet.giveUp).toBe(false);
    const atCap = stepIngestWatch(docs, new Set(["batch-1"]), 40, 40);
    expect(atCap.giveUp).toBe(true);
    const pastCap = stepIngestWatch(docs, new Set(["batch-1"]), 41, 40);
    expect(pastCap.giveUp).toBe(true);
  });

  it("never gives up once everything has resolved before the cap, even at/past maxAttempts", () => {
    const docs: IngestWatchDocument[] = [
      { uploadBatchId: "batch-1", ingestStatus: "ready" },
      { uploadBatchId: "batch-1", ingestStatus: "failed" },
    ];
    const result = stepIngestWatch(docs, new Set(["batch-1"]), 100, 40);
    expect(result.pendingCount).toBe(0);
    expect(result.giveUp).toBe(false);
  });

  it("returns an empty result for an empty watched-batch-id set without giving up", () => {
    const docs: IngestWatchDocument[] = [{ uploadBatchId: "batch-1", ingestStatus: "pending" }];
    const result = stepIngestWatch(docs, new Set(), 40, 40);
    expect(result).toEqual({ pendingCount: 0, readyCount: 0, failedCount: 0, giveUp: false });
  });
});
