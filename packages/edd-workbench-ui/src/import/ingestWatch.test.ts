import { describe, expect, it } from "vitest";
import { stepIngestWatch } from "./ingestWatch.js";

describe("stepIngestWatch", () => {
  it("moves every watched id to ready when the lookup says so, with none still pending", () => {
    const result = stepIngestWatch(["a", "b"], { a: "ready", b: "ready" }, 1, 40);
    expect(result).toEqual({ stillPending: [], readyCount: 2, failedCount: 0, giveUp: false });
  });

  it("splits a mixed batch into ready/failed/still-pending correctly", () => {
    const result = stepIngestWatch(["a", "b", "c", "d"], { a: "ready", b: "failed", c: "pending", d: "processing" }, 1, 40);
    expect(result.readyCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.stillPending).toEqual(["c", "d"]);
    expect(result.giveUp).toBe(false);
  });

  it("treats an id absent from the lookup as still-pending (unknown), not terminal", () => {
    const result = stepIngestWatch(["a"], {}, 1, 40);
    expect(result.stillPending).toEqual(["a"]);
    expect(result.readyCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  it("gives up exactly at maxAttempts when ids remain pending", () => {
    const notYet = stepIngestWatch(["a"], { a: "pending" }, 39, 40);
    expect(notYet.giveUp).toBe(false);
    const atCap = stepIngestWatch(["a"], { a: "pending" }, 40, 40);
    expect(atCap.giveUp).toBe(true);
    const pastCap = stepIngestWatch(["a"], { a: "pending" }, 41, 40);
    expect(pastCap.giveUp).toBe(true);
  });

  it("never gives up once everything has resolved before the cap, even at/past maxAttempts", () => {
    const result = stepIngestWatch(["a", "b"], { a: "ready", b: "failed" }, 100, 40);
    expect(result.stillPending).toEqual([]);
    expect(result.giveUp).toBe(false);
  });

  it("returns an empty result for an empty watched-id list without giving up", () => {
    const result = stepIngestWatch([], {}, 40, 40);
    expect(result).toEqual({ stillPending: [], readyCount: 0, failedCount: 0, giveUp: false });
  });
});
