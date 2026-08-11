import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { DocumentStore } from "./documentStore.js";

/**
 * The real Secure Document Repository (deployment doc Section 3.3/8.1) —
 * private bucket, never public, every read goes through a short-lived
 * presigned URL. Requires real AWS credentials/role to exercise; not
 * covered by the local test suite for that reason (same situation as the
 * Auth0 Management API client in Phase 1 — see docs/auth0-setup.md).
 */
export class S3DocumentStore implements DocumentStore {
  private readonly client: S3Client;

  constructor(private readonly bucket: string, region: string) {
    this.client = new S3Client({ region });
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async getDownloadUrl(key: string, opts: { expiresInSeconds: number }): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: opts.expiresInSeconds });
  }
}
