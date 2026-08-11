import { SQSClient } from "@aws-sdk/client-sqs";

// SQS_ENDPOINT is set for ElasticMQ in local dev (see
// apps/edd-workbench/docker-compose.yml) — unset in production, where the
// real AWS SQS endpoint applies automatically. ElasticMQ doesn't validate
// credentials at all, so any non-empty values satisfy the SDK's own
// requirement that some credentials be present.
const endpoint = process.env.SQS_ENDPOINT;

export const sqsClient = new SQSClient({
  region: process.env.AWS_REGION ?? "eu-west-2",
  ...(endpoint
    ? {
        endpoint,
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      }
    : {}),
});
