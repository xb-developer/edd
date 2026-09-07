export interface MatterDTO {
  id: string;
  name: string;
  referenceCode: string | null;
  status: string;
  /** Used client-side to decide whether the current user may manage this matter's access list (admin-or-creator gate — see matterMembers.ts). */
  createdBy: string | null;
  createdAt: string;
}

/** A user who already has access to a matter — see matterMembers.ts's GET /. */
export interface MatterMemberDTO {
  userId: string;
  email: string;
  name: string | null;
}

/**
 * An org member (per Auth0 — the sole source of truth for org membership,
 * not a local table) who does NOT already have access to this matter.
 * Deliberately no `userId` — a candidate who's never logged into this app
 * yet has no local user row; addMatterMember (api.ts) sends the Auth0
 * identity instead, and the server creates one if needed.
 */
export interface MatterMemberCandidateDTO {
  auth0UserId: string;
  email: string;
  name: string | null;
}

/** The result of asking a matter-scoped RAG question — see ask.ts. `relevantDocuments` is decided by retrieval (deterministic, cosine-similarity), `answer` is generated prose grounded only in those documents' matching excerpts. */
export interface AskResultDTO {
  answer: string;
  relevantDocuments: { documentId: string; guid: string; filename: string }[];
}

/** A matter-scoped full-text search result — see search.ts. totalHits may exceed documentIds.length if the match count was capped server-side. */
export interface SearchResultDTO {
  documentIds: string[];
  totalHits: number;
}

/** The calling admin's own org: Elasticsearch's live document count vs. Postgres's own ready/failed count — see searchHealth.ts. A mismatch usually means the search index needs reindexSearch.ts re-run (e.g. after an Elasticsearch instance replacement). */
export interface SearchHealthDTO {
  esDocCount: number;
  postgresDocCount: number;
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
  /** Its own axis from ingestStatus (see migration 029) — "excluded" for every document whose content type never goes through OCR at all (docx, eml, a pdf with a real text layer, ...); "processing"/"ready"/"failed" only for documents that were actually handed off to the OCR service. Powers the "OCR" Processing Filter option, which selects "ready" specifically. */
  ocrStatus: "excluded" | "processing" | "ready" | "failed";
  title: string | null;
  /** For an email, the sender's display name (or their address if no name was given) — NOT the combined "Name <address>" form. For docx/xlsx/pptx/odt/ods/odp/epub/rtf/html, the document's own Author metadata property. Null for formats with no author concept (pdf, image/tiff, plain text). */
  author: string | null;
  subject: string | null;
  docDate: string | null;
  /** The source document's OWN internal last-modified metadata property (docProps/core.xml's dcterms:modified for docx/pptx/xlsx, officeparser's own reading for odt/ods/odp/epub/rtf/html) — NOT fileModifiedAt, which is the uploaded file's browser-reported mtime. Null wherever the property isn't available for a format (email, legacy .doc, pdf, image/tiff, text/other). */
  contentModifiedAt: string | null;
  /** Comma-joined recipient addresses (eml/msg only) — null for every other content type. */
  toAddresses: string | null;
  /** Comma-joined Cc addresses (eml/msg only) — null for every other content type. */
  ccAddresses: string | null;
  // Type-specific extras (eml/msg's to/cc/bodyText/bodyHtml/attachmentFilenames)
  // — see build plan §2's "hybrid columns + jsonb" decision.
  metadata: Record<string, unknown> | null;
  /** Set when this document's extracted text resembles an AI prompt-injection attempt (see COLLATE_SECURITY_FINDINGS.md Finding 1 and embedding.ts's own detection pass) — null for every ordinary document. A warning, not a block: the document is still fully searchable/AI-indexed, so a reviewer can judge an AI answer citing it accordingly. */
  contentWarning: string | null;
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

/**
 * A rejected file (e.g. over the matter's 3GB storage quota — see
 * matterQuota.ts/documents.ts's init-upload route) comes back as
 * `{ error }` at that file's own index, never omitted — the server always
 * returns one result per requested file, in the same order, so a shorter
 * array would desync every later file's own upload from the wrong
 * presigned URL.
 */
export type InitUploadResultDTO =
  | {
      documentId: string;
      guid: string;
      /** Presigned S3 PUT URL, 15-minute expiry — the client uploads the file's own bytes here directly, not through the app server. */
      uploadUrl: string;
    }
  | { error: string };

/** A create-job -> enqueue -> worker-builds-artifact -> poll -> presigned-download export job, real end to end (see exports.ts/handlers/export.ts) — not the earlier UI-only scaffolding. */
export interface ExportJobDTO {
  exportId: string;
  kind: "documents" | "properties";
  status: "pending" | "processing" | "ready" | "failed";
  error: string | null;
}

/**
 * One queue's status — see workerStatus.ts. `heartbeat` is the worker
 * process's own liveness (org/matter-independent — there's only one worker
 * process, not one per tenant); null means "no data yet" (e.g. the worker
 * hasn't ticked since deploy), not an error. `queued`/`ok`/`failed` are
 * this specific matter's own document (ingest queue) or export-job (export
 * queue) counts, not the queue's global lifetime/depth totals.
 */
export interface WorkerQueueStatusDTO {
  name: string;
  heartbeat: {
    queueName: string;
    lastTickAt: string | null;
    processingStartedAt: string | null;
  } | null;
  queued: number;
  ok: number;
  failed: number;
}

export interface WorkerStatusDTO {
  queues: WorkerQueueStatusDTO[];
}
