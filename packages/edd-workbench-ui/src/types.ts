export interface MatterDTO {
  id: string;
  name: string;
  referenceCode: string | null;
  status: string;
  createdAt: string;
}

export interface DocumentDTO {
  documentId: string;
  guid: string;
  /** The formatted GUID of this document's family root — never null, since a document with no parent is its own family root. NOT the same as the direct parent: every descendant in a multi-level tree (e.g. a PST message's own attachment) shares the same familyGuid as the tree's root, not its immediate parent's. Resolved server-side via a self-join on family_document_id — see documents.ts's DOCUMENT_SELECT. */
  familyGuid: string;
  /** The formatted GUID of this document's direct parent (one level up) — null for a top-level document. Distinct from familyGuid at depth 2+. */
  parentGuid: string | null;
  /** Nesting depth within its family tree — 0 for a top-level document, 1 for a direct attachment, 2 for that attachment's own attachment, etc. */
  depth: number;
  originalFilename: string;
  extension: string;
  sizeBytes: number;
  /** The uploaded file's own last-modified timestamp (from the browser's `File.lastModified`, sent via `initUpload`). Null for anything uploaded before this field existed, or for documents seeded some other way. */
  fileModifiedAt: string | null;
  contentTypeDetected: string;
  ingestStatus: "pending" | "processing" | "ready" | "failed";
  ingestError: string | null;
  title: string | null;
  author: string | null;
  subject: string | null;
  docDate: string | null;
  // Type-specific extras (eml/msg's to/cc/bodyText/bodyHtml/attachmentFilenames)
  // — see build plan §2's "hybrid columns + jsonb" decision.
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// Coding/tagging (see apps/edd-workbench/CONTEXT.md for the "coding"/"tag
// set" vocabulary) has no backend yet — these types are the real contract
// the UI is built against ahead of it, per the milestone's "structurally
// real scaffolding" decision. Not expected to change when the backend
// lands, only the ApiClient methods' implementations underneath them.
export interface TagDTO {
  id: string;
  name: string;
  /** A real hex color (e.g. "#1F6C8C") — undefined for the neutral default. Used both as a toggle pill's "on" fill and, at low opacity, a chip's background — see styles.css's `.tag-toggle`/`.chip`. */
  color?: string;
}

export interface TagSetDTO {
  id: string;
  name: string;
  tags: TagDTO[];
}

export interface InitUploadFileDTO {
  filename: string;
  size: number;
  contentType?: string;
  /** `File.lastModified`'s exact shape (epoch ms) — passed straight through with no conversion. */
  lastModified?: number;
}

export interface InitUploadResultDTO {
  documentId: string;
  guid: string;
  /** Presigned S3 PUT URL, 15-minute expiry — the client uploads the file's own bytes here directly, not through the app server. */
  uploadUrl: string;
}

/** A create-job -> enqueue -> worker-builds-artifact -> poll -> presigned-download export job, real end to end (see exports.ts/handlers/export.ts) — not the earlier UI-only scaffolding. */
export interface ExportJobDTO {
  exportId: string;
  kind: "documents" | "properties";
  status: "pending" | "processing" | "ready" | "failed";
  error: string | null;
}
