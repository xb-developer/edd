import "dotenv/config";
import type { DocumentStore } from "./documentStore.js";
import { LocalFsDocumentStore } from "./localFsStore.js";
import { S3DocumentStore } from "./s3Store.js";

export { documentKey } from "./documentStore.js";
export type { DocumentStore } from "./documentStore.js";

let store: DocumentStore | undefined;

/** Selects the DocumentStore implementation once, based on DOCUMENT_STORE. */
export function getDocumentStore(): DocumentStore {
  if (store) return store;

  const kind = process.env.DOCUMENT_STORE ?? "local";
  if (kind === "s3") {
    const bucket = process.env.S3_BUCKET;
    const region = process.env.AWS_REGION;
    if (!bucket || !region) throw new Error("S3_BUCKET and AWS_REGION are required when DOCUMENT_STORE=s3");
    store = new S3DocumentStore(bucket, region);
  } else {
    const root = process.env.LOCAL_STORE_ROOT ?? "./data/repository";
    const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4520}`;
    store = new LocalFsDocumentStore(root, publicBaseUrl);
  }
  return store;
}
