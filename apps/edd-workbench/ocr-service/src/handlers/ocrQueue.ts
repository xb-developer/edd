import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { withOrgSession, sqsClient, DOCUMENTS_BUCKET } from "@xbundle/edd-workbench-core";
import { extractTextViaTextract } from "../textract.js";

// Read at module-load time, matching the pattern ingest.ts/containerExpansion.ts
// already use for their own required queue-URL env vars.
const EMBEDDING_QUEUE_URL = process.env.EDD_WORKBENCH_EMBEDDING_QUEUE_URL;
if (!EMBEDDING_QUEUE_URL) {
  throw new Error("EDD_WORKBENCH_EMBEDDING_QUEUE_URL environment variable is required");
}

/**
 * Handles one { documentId, orgId } message off the ocr queue — see
 * ingest.ts's hand-off for what enqueues these (a pdf with no real text
 * layer, or an image/tiff). Deliberately does NOT hold one DB transaction
 * open across the whole OCR call the way ingest.ts's own handler does for
 * its (sub-second) extractors: Textract's job can legitimately take tens
 * of seconds to a few minutes, and holding a checked-out pool connection
 * idle-in-transaction for that long is a real cost ingest.ts's fast
 * extractors never had to worry about. Instead: a short read, the slow
 * OCR call with no open transaction, then a short write.
 */
export async function handleOcrMessage(body: string): Promise<void> {
  const { documentId, orgId } = JSON.parse(body) as { documentId: string; orgId: string };

  const s3Key = await withOrgSession(orgId, async (client) => {
    const rows = await client.query<{ s3_key: string | null }>("SELECT s3_key FROM documents WHERE id = $1", [documentId]);
    return rows.rows[0]?.s3_key ?? null;
  });
  // The document (or its S3 key) is gone — most likely deleted between
  // being enqueued and this message being picked up. Nothing to do; not
  // an error worth failing/retrying the message over.
  if (!s3Key) return;

  try {
    const text = await extractTextViaTextract({ bucket: DOCUMENTS_BUCKET, key: s3Key });
    await withOrgSession(orgId, (client) =>
      client.query("UPDATE documents SET metadata = $1, ingest_status = 'ready' WHERE id = $2", [JSON.stringify({ text }), documentId]),
    );
    // Mirrors ingest.ts's own hand-off — OCR reaching a final 'ready'
    // outcome is exactly the same trigger point for embedding eligibility
    // as any other extractor's own 'ready' outcome.
    await sqsClient.send(new SendMessageCommand({ QueueUrl: EMBEDDING_QUEUE_URL, MessageBody: JSON.stringify({ documentId, orgId }) }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withOrgSession(orgId, (client) =>
      client.query("UPDATE documents SET ingest_status = 'failed', ingest_error = $1 WHERE id = $2", [message, documentId]),
    );
  }
}
