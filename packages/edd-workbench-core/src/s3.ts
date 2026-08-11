import { S3Client } from "@aws-sdk/client-s3";

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
