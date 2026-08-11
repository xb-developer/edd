export interface DocumentStore {
  /** Writes raw bytes to `key`, creating any parent structure as needed. */
  put(key: string, data: Buffer): Promise<void>;
  /** Reads raw bytes back out. Throws if `key` doesn't exist. */
  get(key: string): Promise<Buffer>;
  /**
   * Returns a URL the caller's browser can fetch directly to download the
   * file, short-lived and scoped to this one key — the S3 implementation
   * returns a real presigned URL; the local implementation returns a
   * signed route into this same server (see src/routes/documents.ts).
   */
  getDownloadUrl(key: string, opts: { expiresInSeconds: number }): Promise<string>;
}

/** Builds the per-tenant, per-matter key every document lands under (Section 3.3/5.2). */
export function documentKey(organizationId: string, matterId: string, guid: string, filename: string): string {
  return `${organizationId}/${matterId}/${guid}-${sanitizeFilename(filename)}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, "_");
}
