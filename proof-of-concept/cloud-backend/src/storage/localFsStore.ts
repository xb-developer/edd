import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentStore } from "./documentStore.js";
import { signLocalDownload } from "./signedUrl.js";

/**
 * Dev/test stand-in for the Secure Document Repository (Section 3.3) — the
 * real thing is S3 (see s3Store.ts). Never used in production; selected via
 * DOCUMENT_STORE=local, and the only reason download URLs need a signature
 * at all here is to mirror the shape of a real presigned URL so route code
 * doesn't need to know which backend it's talking to.
 */
export class LocalFsDocumentStore implements DocumentStore {
  constructor(private readonly root: string, private readonly publicBaseUrl: string) {}

  private fullPath(key: string): string {
    // key is built by documentKey() from server-generated ids, but guard
    // against path traversal regardless — never trust a key blindly.
    const normalized = path.normalize(key).replace(/^([.]{2}[/\\])+/, "");
    return path.join(this.root, normalized);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.fullPath(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.fullPath(key));
  }

  async getDownloadUrl(key: string, opts: { expiresInSeconds: number }): Promise<string> {
    const { token, expires } = signLocalDownload(key, opts.expiresInSeconds);
    const params = new URLSearchParams({ key, expires: String(expires), token });
    return `${this.publicBaseUrl}/documents/local-download?${params.toString()}`;
  }
}
