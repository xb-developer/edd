import { describe, expect, it } from "vitest";
import { openViewerChannel, postViewerMessage, subscribeToViewerChannel } from "./viewerChannel.js";

// Real BroadcastChannel instances — a genuine global in Node 22, no mock —
// matching this project's real-substitutes testing convention applied to a
// browser API instead of Postgres/S3/SQS. Every channel opened here is
// explicitly closed so the test process doesn't hang.
describe("viewerChannel", () => {
  it("delivers a message with a matching sessionId to a subscriber", async () => {
    const senderChannel = openViewerChannel();
    const receiverChannel = openViewerChannel();
    try {
      const received = await new Promise((resolve) => {
        subscribeToViewerChannel(receiverChannel, "session-1", resolve);
        postViewerMessage(senderChannel, { type: "select", sessionId: "session-1", matterId: "matter-1", documentId: "doc-1" });
      });

      expect(received).toEqual({ type: "select", sessionId: "session-1", matterId: "matter-1", documentId: "doc-1" });
    } finally {
      senderChannel.close();
      receiverChannel.close();
    }
  });

  it("ignores a message whose sessionId doesn't match the subscriber's own — different tabs of the app must never cross-wire each other's viewers", async () => {
    const senderChannel = openViewerChannel();
    const receiverChannel = openViewerChannel();
    try {
      let receivedForOtherSession = false;
      subscribeToViewerChannel(receiverChannel, "session-1", () => {
        receivedForOtherSession = true;
      });

      const matchingReceived = new Promise((resolve) => {
        subscribeToViewerChannel(receiverChannel, "session-2", resolve);
      });

      postViewerMessage(senderChannel, { type: "close", sessionId: "session-2" });
      await matchingReceived;

      expect(receivedForOtherSession).toBe(false);
    } finally {
      senderChannel.close();
      receiverChannel.close();
    }
  });

  it("unsubscribe stops delivering further messages", async () => {
    const senderChannel = openViewerChannel();
    const receiverChannel = openViewerChannel();
    try {
      let callCount = 0;
      const unsubscribe = subscribeToViewerChannel(receiverChannel, "session-1", () => {
        callCount++;
      });
      unsubscribe();

      postViewerMessage(senderChannel, { type: "hello", sessionId: "session-1" });
      // No direct way to "wait for a message that shouldn't arrive" other
      // than a short delay — bounded and small, not a flaky-timing test
      // since we're asserting an absence within a generous window.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(callCount).toBe(0);
    } finally {
      senderChannel.close();
      receiverChannel.close();
    }
  });
});
