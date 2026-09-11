import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";

// S3_ENDPOINT is set for MinIO in local dev (see
// apps/edd-workbench/docker-compose.yml) — unset in production, where the
// real AWS S3 endpoint applies automatically and IAM role credentials are
// used instead of the MinIO defaults below.
const endpoint = process.env.S3_ENDPOINT;

export const s3Client = new S3Client({
  region: process.env.AWS_REGION ?? "eu-west-2",
  ...(endpoint
    ? {
        endpoint,
        forcePathStyle: true, // MinIO needs bucket-in-path, not subdomain-style, addressing
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
        },
      }
    : {}),
});

export const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET ?? "edd-workbench-staging-documents";

/** S3's own hard limit for DeleteObjects — 1,000 keys per request. */
const DELETE_OBJECTS_CHUNK = 1000;

/**
 * Deletes many objects, best-effort: failures are logged (with the keys
 * that failed), never thrown. Every caller here deletes S3 objects only
 * AFTER the corresponding DB rows are already gone — the rows are what the
 * rest of the app treats as "does this document exist" — so a failure
 * leaves an orphaned object, which is recoverable, while throwing would
 * turn an already-committed delete into a 500.
 *
 * Batched via DeleteObjects rather than one DeleteObject per key:
 * `Promise.all(keys.map(send))` had no concurrency bound at all, so
 * deleting a large matter opened one socket per document simultaneously
 * from a single Node process — file-descriptor exhaustion, not slowness.
 */
export async function deleteS3ObjectsBestEffort(keys: readonly string[], context: string): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_OBJECTS_CHUNK) {
    const chunk = keys.slice(i, i + DELETE_OBJECTS_CHUNK);
    try {
      const result = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: DOCUMENTS_BUCKET,
          // Quiet mode still reports errors, just not the successes —
          // which is all this needs, and keeps the response small for a
          // 1,000-key batch.
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      for (const err of result.Errors ?? []) {
        console.error(`Failed to delete S3 object ${err.Key} during ${context}: ${err.Code} ${err.Message}`);
      }
    } catch (err) {
      console.error(`Failed to delete a batch of ${chunk.length} S3 object(s) during ${context}:`, err);
    }
  }
}
