import { afterEach, describe, expect, it, vi } from "vitest";
import { StartDocumentTextDetectionCommand, GetDocumentTextDetectionCommand } from "@aws-sdk/client-textract";
import { textractClient, extractTextViaTextract, POLL_INTERVAL_MS } from "./textract.js";

// Textract has no local emulator (unlike S3/SQS's MinIO/ElasticMQ
// substitutes) — mocking the shared client is the only way to exercise
// this polling/pagination logic without a real AWS account/call.
function mockSend(responses: unknown[]) {
  let call = 0;
  // send() is overloaded per-command-type in the AWS SDK v3 client, which
  // makes a plain mockResolvedValueOnce(response) fail to typecheck against
  // any one specific overload — `as never` sidesteps that for test-only code.
  return vi.spyOn(textractClient, "send").mockImplementation(async () => responses[call++] as never);
}

describe("extractTextViaTextract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a job and returns joined line text once it succeeds on the first poll", async () => {
    const send = mockSend([
      { JobId: "job-1" },
      {
        JobStatus: "SUCCEEDED",
        Blocks: [
          { BlockType: "LINE", Text: "First line" },
          { BlockType: "WORD", Text: "ignored" },
          { BlockType: "LINE", Text: "Second line" },
        ],
      },
    ]);

    const text = await extractTextViaTextract({ bucket: "my-bucket", key: "docs/a.pdf" });

    expect(text).toBe("First line\nSecond line");
    expect(send.mock.calls[0][0]).toBeInstanceOf(StartDocumentTextDetectionCommand);
    expect(send.mock.calls[0][0].input).toEqual({
      DocumentLocation: { S3Object: { Bucket: "my-bucket", Name: "docs/a.pdf" } },
    });
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetDocumentTextDetectionCommand);
  });

  it("polls through IN_PROGRESS statuses before returning once SUCCEEDED", async () => {
    // Fake timers so the real 2s-per-poll delay doesn't actually elapse —
    // advanceTimersByTimeAsync below fires each setTimeout immediately.
    vi.useFakeTimers();
    try {
      mockSend([
        { JobId: "job-2" },
        { JobStatus: "IN_PROGRESS" },
        { JobStatus: "IN_PROGRESS" },
        { JobStatus: "SUCCEEDED", Blocks: [{ BlockType: "LINE", Text: "Eventually done" }] },
      ]);

      const resultPromise = extractTextViaTextract({ bucket: "b", key: "k" });
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(await resultPromise).toBe("Eventually done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows NextToken to collect every page of a multi-page result", async () => {
    mockSend([
      { JobId: "job-3" },
      {
        JobStatus: "SUCCEEDED",
        NextToken: "page-2-token",
        Blocks: [{ BlockType: "LINE", Text: "Page one line" }],
      },
      {
        JobStatus: "SUCCEEDED",
        Blocks: [{ BlockType: "LINE", Text: "Page two line" }],
      },
    ]);

    const text = await extractTextViaTextract({ bucket: "b", key: "k" });
    expect(text).toBe("Page one line\nPage two line");
  });

  it("throws with Textract's own status message when the job fails", async () => {
    mockSend([{ JobId: "job-4" }, { JobStatus: "FAILED", StatusMessage: "Unsupported document format" }]);

    await expect(extractTextViaTextract({ bucket: "b", key: "k" })).rejects.toThrow("Unsupported document format");
  });

  it("throws if StartDocumentTextDetection returns no JobId", async () => {
    mockSend([{}]);
    await expect(extractTextViaTextract({ bucket: "b", key: "k" })).rejects.toThrow("no JobId");
  });
});
