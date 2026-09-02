import { TextractClient, StartDocumentTextDetectionCommand, GetDocumentTextDetectionCommand } from "@aws-sdk/client-textract";
import type { GetDocumentTextDetectionCommandOutput } from "@aws-sdk/client-textract";

// Exported so tests can vi.spyOn(textractClient, "send") — same reasoning
// as core's own exported sqsClient/s3Client: Textract has no local
// emulator the way MinIO/ElasticMQ stand in for S3/SQS, so mocking this
// one real AWS client is the only way to test the polling/pagination logic
// below without actually calling AWS.
export const textractClient = new TextractClient({ region: process.env.AWS_REGION ?? "eu-west-2" });

// Exported so tests can drive vi.advanceTimersByTimeAsync by the exact real
// interval, rather than either hardcoding a duplicate constant or eating a
// real multi-second delay per polling test.
export const POLL_INTERVAL_MS = 2000;
// ~5 minutes — comfortably under the ocr SQS queue's own visibility
// timeout (see the CDK stack), so a job that's still legitimately running
// when this gives up doesn't also get double-picked-up by another
// consumer before this one's own failure write lands.
const MAX_POLL_ATTEMPTS = 150;

/**
 * Runs Amazon Textract's async text-detection job against a document
 * already sitting in S3 (Textract reads it directly — no download needed
 * here) and returns its plain text, all lines in reading order. This is
 * the ENTIRE surface Textract-specific code touches in this service —
 * everything else (the REST route, the queue handler) only ever calls
 * this one function, so swapping the underlying OCR engine later (a
 * self-hosted model, a different vendor) means changing only this file.
 *
 * Polls GetDocumentTextDetection rather than using Textract's optional SNS
 * completion notification — that needs its own topic/IAM wiring for no
 * real benefit here, since this call's caller is itself an async queue
 * consumer with nothing better to do while waiting.
 */
export async function extractTextViaTextract(params: { bucket: string; key: string }): Promise<string> {
  const { JobId } = await textractClient.send(
    new StartDocumentTextDetectionCommand({ DocumentLocation: { S3Object: { Bucket: params.bucket, Name: params.key } } }),
  );
  if (!JobId) throw new Error("Textract StartDocumentTextDetection returned no JobId");

  let firstPage: GetDocumentTextDetectionCommandOutput | undefined;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    firstPage = await textractClient.send(new GetDocumentTextDetectionCommand({ JobId }));
    if (firstPage.JobStatus === "SUCCEEDED" || firstPage.JobStatus === "PARTIAL_SUCCESS" || firstPage.JobStatus === "FAILED") break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (!firstPage || firstPage.JobStatus === "IN_PROGRESS") {
    throw new Error(`Textract job ${JobId} did not complete within the polling timeout`);
  }
  if (firstPage.JobStatus === "FAILED") {
    throw new Error(firstPage.StatusMessage ?? `Textract job ${JobId} failed`);
  }

  // SUCCEEDED/PARTIAL_SUCCESS results are paginated across possibly many
  // Blocks pages for a multi-page document — firstPage already holds page
  // one, so only fetch more while NextToken keeps showing up.
  const lines: string[] = [];
  let page: GetDocumentTextDetectionCommandOutput = firstPage;
  let nextToken: string | undefined;
  do {
    if (nextToken) page = await textractClient.send(new GetDocumentTextDetectionCommand({ JobId, NextToken: nextToken }));
    for (const block of page.Blocks ?? []) {
      if (block.BlockType === "LINE" && block.Text) lines.push(block.Text);
    }
    nextToken = page.NextToken;
  } while (nextToken);

  return lines.join("\n");
}
