import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  withOrgSession,
  s3Client,
  sqsClient,
  nextMatterGuid,
  detectContentType,
  mimeTypeFor,
  iteratePstMessages,
  extractZipMembers,
  extractSevenZipMembers,
  iterateMboxMessages,
  DOCUMENTS_BUCKET,
  type ContentType,
} from "@xbundle/edd-workbench-core";

// Read at module-load time, matching ingest.ts's own "fail loudly at
// startup, not on first request" convention.
const INGEST_QUEUE_URL = process.env.EDD_WORKBENCH_INGEST_QUEUE_URL;
if (!INGEST_QUEUE_URL) {
  throw new Error("EDD_WORKBENCH_INGEST_QUEUE_URL environment variable is required");
}

/**
 * Postgres `text` columns can never contain a NUL byte, in any encoding —
 * confirmed for real against a genuinely corrupt PST fixture, whose thrown
 * error message embeds raw bytes from the file itself. Shared by every
 * container's own "the container itself couldn't be opened at all" failure
 * path.
 */
export function sanitizeForPostgresText(value: string): string {
  return value.replace(new RegExp(String.fromCharCode(0), "g"), "");
}

// Shared by every container/attachment shape — zip/7z/PST/mbox members AND
// eml/msg/PST-message attachments all go through the same expandMembers
// core below, so this is the ONE depth ceiling all of them respect.
// Previously only email attachments had an equivalent cap
// (MAX_ATTACHMENT_EXPANSION_DEPTH) — zip/7z/PST/mbox had none at all, an
// inconsistency nobody would have caught reading any one handler in
// isolation. A circular/pathological chain (a forwarded email attaching
// itself, a zip nested inside itself many times) has no natural
// termination otherwise, since expansion recurses purely via the SQS
// queue.
export const MAX_CONTAINER_EXPANSION_DEPTH = 5;

export interface ContainerMember {
  filename: string;
  content: Buffer;
  /** Overrides detectContentType(filename) — mbox members are always a real 'eml' regardless of their synthesized filename, matching the same hardcoding this replaces. */
  contentTypeOverride?: ContentType;
  /** Stored as-is in the new child row's own metadata column (e.g. zip's `{source: "zip", zipPath}`) — omitted (null) for a plain attachment, matching today's contract exactly. */
  metadata?: Record<string, unknown> | null;
}

export interface MemberFailure {
  filename: string;
  error: string;
}

export interface ExpandMembersResult {
  succeeded: number;
  failures: MemberFailure[];
  /**
   * True when the depth cap stopped expansion before any member was even
   * looked at. Distinct from "genuinely empty container" (succeeded === 0,
   * failures === [], depthCapped === false) — finalizeTransparentContainer
   * must never treat the two the same way: a depth-capped container still
   * has real, unextracted content sitting in its own S3 object, and
   * deleting it (the "fully successful, nothing left to review" rule)
   * would silently discard that content instead of just declining to
   * recurse further into it.
   */
  depthCapped: boolean;
}

/**
 * The parent_document_id/family_document_id every message/member inside a
 * transparent container (zip/7z/PST/mbox) should use, computed once per
 * member from the container's own already-persisted row:
 *
 *   containerIsTopLevel = (container.parentDocumentId === null)
 *   member.parent_document_id = container.parentDocumentId   // pass through (null if top-level)
 *   member.family_document_id = containerIsTopLevel ? newOwnId : container.familyDocumentId
 *
 * If the container was a plain top-level upload, its own parentDocumentId
 * is null, so each member becomes its own independent family root. If the
 * container instead arrived nested (e.g. a .zip attached to an email),
 * its members become direct children of that real ancestor, skipping
 * over the invisible container level rather than losing the real
 * evidentiary link to it. `depth` is NOT computed here — it's always the
 * container's own depth, unchanged, passed straight through by the caller
 * (see expandTransparentContainerMembers below).
 */
export function containerPassThrough(
  container: { parentDocumentId: string | null; familyDocumentId: string },
  newOwnId: string,
): { parentDocumentId: string | null; familyDocumentId: string } {
  const containerIsTopLevel = container.parentDocumentId === null;
  return {
    parentDocumentId: container.parentDocumentId,
    familyDocumentId: containerIsTopLevel ? newOwnId : container.familyDocumentId,
  };
}

/**
 * The one shared per-member transactional primitive — replaces the
 * per-member loop body that used to be duplicated, with small
 * inconsistencies, across handleZipIngest/handleSevenZipIngest/
 * handleMboxIngest/expandAttachments. Given a lineage function (how to
 * compute each member's own parent_document_id/family_document_id — see
 * expandTransparentContainerMembers/expandRealNodeAttachments below for
 * the two real shapes) and a fixed depth for the whole call, inserts each
 * member as its own 'pending' child document, uploads its real bytes to
 * S3, and re-enqueues it so it gets fully processed by re-entering
 * handleIngestMessage — no duplicated parsing logic for whatever format
 * the member turns out to be, exactly like today's established recursion
 * pattern.
 *
 * One withOrgSession transaction per member (lock-avoidance — a real
 * eDiscovery container can hold thousands of members; one shared
 * transaction would hold the matter's GUID-counter row lock for the
 * container's entire processing time, and one bad member partway through
 * would roll back every sibling that had already committed alongside it).
 * A failure partway through one member's own insert/upload/enqueue rolls
 * back just that member's row — never a sibling's — and is captured into
 * the returned `failures` array (filename + real error message), not
 * merely `console.error`'d: a swallowed failure with no durable record is
 * exactly how a real production issue (a real email, `ingest_status =
 * 'ready'`, zero children — not even its two ordinary PDF attachments —
 * with zero visible cause anywhere) went unexplained.
 *
 * Depth-capped uniformly for every caller — see
 * MAX_CONTAINER_EXPANSION_DEPTH's own comment above.
 */
export async function expandMembers(params: {
  orgId: string;
  matterId: string;
  depth: number;
  computeLineage: (childDocumentId: string) => { parentDocumentId: string | null; familyDocumentId: string };
  members: AsyncIterable<ContainerMember> | Iterable<ContainerMember>;
}): Promise<ExpandMembersResult> {
  const failures: MemberFailure[] = [];
  let succeeded = 0;
  if (params.depth >= MAX_CONTAINER_EXPANSION_DEPTH) return { succeeded, failures, depthCapped: true };

  for await (const member of params.members) {
    if (member.content.byteLength === 0) continue;
    try {
      await withOrgSession(params.orgId, async (client) => {
        const extension = member.filename.toLowerCase().split(".").pop() ?? "";
        const contentType = member.contentTypeOverride ?? detectContentType(member.filename);
        const childDocumentId = randomUUID();
        const guidNumber = await nextMatterGuid(client, params.matterId);
        const s3Key = `tenants/${params.orgId}/matters/${params.matterId}/documents/${childDocumentId}/original.${extension}`;
        const { parentDocumentId, familyDocumentId } = params.computeLineage(childDocumentId);

        await client.query(
          `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13)`,
          [
            childDocumentId,
            params.orgId,
            params.matterId,
            parentDocumentId,
            familyDocumentId,
            params.depth,
            guidNumber,
            member.filename,
            extension,
            member.content.byteLength,
            s3Key,
            contentType,
            member.metadata ? JSON.stringify(member.metadata) : null,
          ],
        );

        // Without ContentType, S3 defaults to application/octet-stream —
        // Chrome's native <iframe> PDF viewer (and other MIME-sensitive
        // inline renderers) then refuses to render the object at all, even
        // though content_type_detected/extension above are already correct
        // in the DB. Top-level uploads set this from the browser's own
        // File.type (documents.ts's init-upload); an expanded member has no
        // such browser-supplied value, so it's derived from the filename
        // the same way detectContentType already is, just at MIME
        // precision instead of this app's coarser internal category.
        await s3Client.send(
          new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key, Body: member.content, ContentType: mimeTypeFor(member.filename) }),
        );
        await sqsClient.send(
          new SendMessageCommand({ QueueUrl: INGEST_QUEUE_URL, MessageBody: JSON.stringify({ documentId: childDocumentId, orgId: params.orgId }) }),
        );
      });
      succeeded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`expandMembers: failed to expand member "${member.filename}":`, err);
      failures.push({ filename: member.filename, error: message });
    }
  }

  return { succeeded, failures, depthCapped: false };
}

/** The transparent-container shape (zip/7z/PST/mbox) — see containerPassThrough's own comment for the formula; depth is the container's own, unchanged. */
export function expandTransparentContainerMembers(params: {
  orgId: string;
  matterId: string;
  container: { parentDocumentId: string | null; familyDocumentId: string; depth: number };
  members: AsyncIterable<ContainerMember> | Iterable<ContainerMember>;
}): Promise<ExpandMembersResult> {
  return expandMembers({
    orgId: params.orgId,
    matterId: params.matterId,
    depth: params.container.depth,
    computeLineage: (childDocumentId) => containerPassThrough(params.container, childDocumentId),
    members: params.members,
  });
}

/**
 * The real-node shape (eml/msg attachments, and a PST message's own
 * attachments) — the parent is a REAL node, not transparent, so every
 * attachment becomes a real child one level deeper, inheriting the
 * parent's own family_document_id unchanged (matches the reference
 * Electron POC's family_id/depth model exactly — see migration 018's own
 * comment for the bug a naive one-level-up self-join used to cause).
 * Replaces expandAttachments.
 */
export function expandRealNodeAttachments(params: {
  orgId: string;
  matterId: string;
  parent: { id: string; familyDocumentId: string; depth: number };
  attachments: ContainerMember[];
}): Promise<ExpandMembersResult> {
  return expandMembers({
    orgId: params.orgId,
    matterId: params.matterId,
    depth: params.parent.depth + 1,
    computeLineage: () => ({ parentDocumentId: params.parent.id, familyDocumentId: params.parent.familyDocumentId }),
    members: params.attachments,
  });
}

/**
 * The shared tail every transparent container (zip/7z/PST/mbox) ends
 * with: the container's own row (and S3 object) is deleted only once
 * EVERY member/message inside it was extracted successfully — if any
 * failed, the container's row is kept exactly as before (visible,
 * ingest_status 'ready', metadata recording which members failed and why)
 * so the failure stays traceable, extended with the real per-member
 * `failures` detail expandMembers now returns (previously just a
 * memberCount/failedMemberCount tally with no way to tell which member or
 * why). A depth-capped result (see ExpandMembersResult's own comment) is
 * kept too, with its own distinct metadata marker — never deleted, since
 * "capped, didn't even look" is not the same outcome as "looked, found
 * nothing left to review."
 */
export async function finalizeTransparentContainer(params: {
  orgId: string;
  documentId: string;
  s3Key: string;
  result: ExpandMembersResult;
}): Promise<void> {
  if (params.result.depthCapped) {
    await withOrgSession(params.orgId, (client) =>
      client.query("UPDATE documents SET ingest_status = 'ready', metadata = $1 WHERE id = $2", [
        JSON.stringify({ depthCapped: true }),
        params.documentId,
      ]),
    );
    return;
  }

  if (params.result.failures.length === 0) {
    await withOrgSession(params.orgId, (client) => client.query("DELETE FROM documents WHERE id = $1", [params.documentId]));
    await s3Client.send(new DeleteObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: params.s3Key })).catch((err) => {
      console.error(`Failed to delete S3 object ${params.s3Key} for transparently-expanded container ${params.documentId}:`, err);
    });
  } else {
    await withOrgSession(params.orgId, (client) =>
      client.query("UPDATE documents SET ingest_status = 'ready', metadata = $1 WHERE id = $2", [
        JSON.stringify({ memberCount: params.result.succeeded, failedMemberCount: params.result.failures.length, failures: params.result.failures }),
        params.documentId,
      ]),
    );
  }
}

/** Shared by every container's own "the container itself couldn't be opened/downloaded/exceeds its size ceiling" failure path — replaces the same 3-line withOrgSession+UPDATE pattern that used to be repeated 12 times across the four format handlers. */
export async function markContainerFailed(orgId: string, documentId: string, error: string): Promise<void> {
  await withOrgSession(orgId, (client) =>
    client.query("UPDATE documents SET ingest_status = 'failed', ingest_error = $1 WHERE id = $2", [error, documentId]),
  );
}

export interface ContainerIngestParams {
  documentId: string;
  orgId: string;
  matterId: string;
  s3Key: string | null;
  sizeBytes: string;
  parentDocumentId: string | null;
  familyDocumentId: string;
  depth: number;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// The worker task's ephemeral storage is 100 GiB (see the CDK stack's
// WorkerTaskDefinition — bumped specifically for this, from Fargate's
// 20 GiB default), but that's shared with the OS layer, the container
// image, and whatever else is transiently on disk — not dedicated purely to
// one PST's temp file. 80 GiB leaves a 20 GiB headroom buffer (chosen to
// match Fargate's own previous default ceiling, an already-proven-adequate
// number for "everything else"). A PST larger than this fails cleanly with
// a recorded ingest_error via the pre-flight check below, before ever
// starting the S3 download — converting a potential mid-stream ENOSPC into
// an observable, recorded failure, not a promise that multi-hundred-GB PSTs
// (a real possibility in enterprise litigation holds) are actually solved.
export const PST_MAX_SIZE_BYTES = 80 * 1024 ** 3;

// Unlike PST (streamed to a local temp file), a zip is buffered fully in
// memory via streamToBuffer — its realistic eDiscovery size doesn't need
// disk-streaming, but that means it directly competes with the worker
// task's 1024 MiB memory limit (both the raw zip buffer AND each
// decompressed member's bytes can be live at once during extraction).
// 400 MiB leaves real headroom for the app's own baseline usage; same
// "convert a potential crash into a clean recorded failure" reasoning as
// PST's own ceiling.
export const ZIP_MAX_SIZE_BYTES = 400 * 1024 ** 2;

// A 7z archive is disk-streamed like PST, not memory-buffered like zip —
// 7z's much higher compression ratios make an in-memory approach a real
// bomb risk at a much smaller input size than a zip's. The ingest queue's
// consumer processes exactly one message at a time per worker task, so a
// PST ingest and a 7z ingest can never run concurrently on one task's
// disk — 7z can reuse PST's own already-claimed 80 GiB budget rather than
// needing separate new headroom. Split as a compressed-archive ceiling
// (checked pre-download, same as PST_MAX_SIZE_BYTES) plus an
// uncompressed-contents ceiling (checked via extractSevenZipMembers's own
// `list()` precheck, before `unpack()` ever runs) summing to that same
// 80 GiB, since the compressed temp file and the fully-extracted tree
// only ever need to coexist on disk briefly (the compressed file is
// deleted immediately once `unpack()` succeeds — see sevenZip.ts).
export const SEVEN_ZIP_MAX_SIZE_BYTES = 10 * 1024 ** 3;
export const SEVEN_ZIP_MAX_UNCOMPRESSED_BYTES = 70 * 1024 ** 3;

// Disk-streamed like PST (temp file, never buffered in memory — a real
// mbox mailbox export can be many GB), with no compression-ratio risk
// since mbox is plain text — reuses PST_MAX_SIZE_BYTES's own value and
// reasoning directly rather than needing a second, split ceiling the way
// 7z does.
export const MBOX_MAX_SIZE_BYTES = 80 * 1024 ** 3;

/**
 * Handles a `zip`-typed document — download (buffered in memory, guarded
 * by ZIP_MAX_SIZE_BYTES), map each real JSZip member into a
 * ContainerMember (metadata `{source: "zip", zipPath}}`, matching today's
 * exact shape), expand via the shared transparent-container pipeline, and
 * finalize (delete-vs-keep). Real per-member expansion/failure/depth-cap
 * mechanics all live in expandMembers now — this function's only job is
 * "how do I get a zip's real bytes out."
 */
export async function handleZipIngest(params: ContainerIngestParams): Promise<void> {
  const { documentId, orgId, matterId, s3Key, sizeBytes, parentDocumentId, familyDocumentId, depth } = params;

  if (Number(sizeBytes) > ZIP_MAX_SIZE_BYTES) {
    await markContainerFailed(
      orgId,
      documentId,
      `Zip is ${sizeBytes} bytes, exceeding this worker's ${ZIP_MAX_SIZE_BYTES}-byte ceiling (see containerExpansion.ts's ZIP_MAX_SIZE_BYTES)`,
    );
    return;
  }
  if (!s3Key) {
    await markContainerFailed(orgId, documentId, "Zip document has no s3_key to download");
    return;
  }

  try {
    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key }));
    const buffer = await streamToBuffer(object.Body as Readable);
    const rawMembers = await extractZipMembers(buffer);
    const members: ContainerMember[] = rawMembers.map((m) => ({
      filename: m.filename,
      content: m.content,
      metadata: { source: "zip", zipPath: m.zipPath },
    }));

    const result = await expandTransparentContainerMembers({ orgId, matterId, container: { parentDocumentId, familyDocumentId, depth }, members });
    await finalizeTransparentContainer({ orgId, documentId, s3Key, result });
  } catch (err) {
    // The zip itself couldn't be opened at all (missing S3 object,
    // genuinely corrupt archive) — the parent document is marked failed,
    // same as every other content type's failure path.
    const message = sanitizeForPostgresText(err instanceof Error ? err.message : String(err));
    await markContainerFailed(orgId, documentId, message);
  }
}

/**
 * Handles a `7z`-typed document — same shape as handleZipIngest, but the
 * archive is disk-streamed (temp file + temp extraction directory,
 * cleaned up in `finally`) rather than buffered in memory, matching
 * sevenZip.ts's own extraction contract.
 */
export async function handleSevenZipIngest(params: ContainerIngestParams): Promise<void> {
  const { documentId, orgId, matterId, s3Key, sizeBytes, parentDocumentId, familyDocumentId, depth } = params;

  if (Number(sizeBytes) > SEVEN_ZIP_MAX_SIZE_BYTES) {
    await markContainerFailed(
      orgId,
      documentId,
      `7z is ${sizeBytes} bytes, exceeding this worker's ${SEVEN_ZIP_MAX_SIZE_BYTES}-byte ceiling (see containerExpansion.ts's SEVEN_ZIP_MAX_SIZE_BYTES)`,
    );
    return;
  }
  if (!s3Key) {
    await markContainerFailed(orgId, documentId, "7z document has no s3_key to download");
    return;
  }

  const tempArchivePath = join(tmpdir(), `7z-ingest-${documentId}.7z`);
  const extractDir = await mkdtemp(join(tmpdir(), `7z-extract-${documentId}-`));

  try {
    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key }));
    await pipeline(object.Body as Readable, createWriteStream(tempArchivePath));

    async function* members(): AsyncGenerator<ContainerMember> {
      for await (const m of extractSevenZipMembers(tempArchivePath, extractDir, SEVEN_ZIP_MAX_UNCOMPRESSED_BYTES)) {
        yield { filename: m.filename, content: m.content, metadata: { source: "7z", zipPath: m.zipPath } };
      }
    }

    const result = await expandTransparentContainerMembers({
      orgId,
      matterId,
      container: { parentDocumentId, familyDocumentId, depth },
      members: members(),
    });
    await finalizeTransparentContainer({ orgId, documentId, s3Key, result });
  } catch (err) {
    // The archive itself couldn't be opened/extracted at all (missing S3
    // object, genuinely corrupt/encrypted archive, or the uncompressed-size
    // ceiling rejected it) — the parent document is marked failed, same as
    // every other content type's failure path.
    const message = sanitizeForPostgresText(err instanceof Error ? err.message : String(err));
    await markContainerFailed(orgId, documentId, message);
  } finally {
    await unlink(tempArchivePath).catch(() => {
      // Best-effort — usually already deleted by extractSevenZipMembers
      // itself immediately after a successful unpack().
    });
    await rm(extractDir, { recursive: true, force: true }).catch(() => {
      // Best-effort cleanup — must never mask whatever the real outcome
      // above already was.
    });
  }
}

/**
 * Handles an `mbox`-typed document — each split message IS already a
 * complete, real RFC822 message (iterateMboxMessages's own contract), so
 * it's wrapped as a ContainerMember with contentTypeOverride: "eml" and
 * re-enqueued as-is — it re-enters the ordinary `eml` branch via the
 * queue, with zero duplicated parsing logic.
 */
export async function handleMboxIngest(params: ContainerIngestParams): Promise<void> {
  const { documentId, orgId, matterId, s3Key, sizeBytes, parentDocumentId, familyDocumentId, depth } = params;

  if (Number(sizeBytes) > MBOX_MAX_SIZE_BYTES) {
    await markContainerFailed(
      orgId,
      documentId,
      `Mbox is ${sizeBytes} bytes, exceeding this worker's ${MBOX_MAX_SIZE_BYTES}-byte ceiling (see containerExpansion.ts's MBOX_MAX_SIZE_BYTES)`,
    );
    return;
  }
  if (!s3Key) {
    await markContainerFailed(orgId, documentId, "Mbox document has no s3_key to download");
    return;
  }

  const tempFilePath = join(tmpdir(), `mbox-ingest-${documentId}.mbox`);

  try {
    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key }));
    await pipeline(object.Body as Readable, createWriteStream(tempFilePath));

    async function* members(): AsyncGenerator<ContainerMember> {
      let index = 0;
      for await (const content of iterateMboxMessages(tempFilePath)) {
        yield {
          filename: `message-${index}.eml`,
          content,
          contentTypeOverride: "eml" as ContentType,
          metadata: { source: "mbox", mboxIndex: index },
        };
        index++;
      }
    }

    const result = await expandTransparentContainerMembers({
      orgId,
      matterId,
      container: { parentDocumentId, familyDocumentId, depth },
      members: members(),
    });
    await finalizeTransparentContainer({ orgId, documentId, s3Key, result });
  } catch (err) {
    // The mbox file itself couldn't be opened/streamed at all (missing S3
    // object) — the parent document is marked failed, same as every other
    // content type's failure path.
    const message = sanitizeForPostgresText(err instanceof Error ? err.message : String(err));
    await markContainerFailed(orgId, documentId, message);
  } finally {
    await unlink(tempFilePath).catch(() => {
      // Best-effort cleanup — a failed unlink must never mask whatever the
      // real outcome above already was.
    });
  }
}

/**
 * Handles a `pst`-typed document. Unlike zip/7z/mbox, pst-extractor hands
 * back each message already fully parsed (subject/from/to/date/body/
 * attachments) — there's nothing to re-extract, so a PST message's own
 * row is inserted directly, immediately `ready`, with its real
 * folderPath/messageClass metadata, rather than round-tripped through a
 * synthesized MIME buffer just to force it through the generic
 * ContainerMember pipeline (that would lose folderPath/messageClass —
 * not standard MIME headers — and cost a real, avoidable re-parse of data
 * pst-extractor already gave us for free). What IS shared with every
 * other container: the same MAX_CONTAINER_EXPANSION_DEPTH cap (PST had
 * none at all before), the same per-message transaction/failure-tracking
 * shape, and — for each message's OWN attachments, which really are raw
 * bytes needing their own extraction — the exact same
 * expandRealNodeAttachments used by real .eml/.msg uploads.
 *
 * The S3 object is streamed straight to a local temp file, not buffered in
 * memory — a PST can be multiple GB, and holding one in memory would risk
 * the worker task OOMing long before any per-message processing even
 * starts.
 *
 * One withOrgSession transaction per message's own row (lock-avoidance —
 * a real eDiscovery PST can hold thousands of messages; one shared
 * transaction would hold the matter's GUID-counter row lock for the PST's
 * entire processing time). Attachment expansion runs AFTER that
 * transaction commits, in its own separate transaction(s) via
 * expandRealNodeAttachments, not nested inside it — nesting it would
 * deadlock: expandRealNodeAttachments calls nextMatterGuid too, which
 * would try to re-lock the very same matter's GUID-counter row the
 * message's own nextMatterGuid call is still holding — a real bug this
 * shape used to have, confirmed by every PST test with real attachments
 * hanging until Vitest's own test timeout.
 */
export async function handlePstIngest(params: ContainerIngestParams): Promise<void> {
  const { documentId, orgId, matterId, s3Key, sizeBytes, parentDocumentId, familyDocumentId, depth } = params;

  if (Number(sizeBytes) > PST_MAX_SIZE_BYTES) {
    await markContainerFailed(
      orgId,
      documentId,
      `PST is ${sizeBytes} bytes, exceeding this worker's ${PST_MAX_SIZE_BYTES}-byte ceiling (see containerExpansion.ts's PST_MAX_SIZE_BYTES)`,
    );
    return;
  }
  if (!s3Key) {
    await markContainerFailed(orgId, documentId, "PST document has no s3_key to download");
    return;
  }
  if (depth >= MAX_CONTAINER_EXPANSION_DEPTH) {
    // Same "didn't even look, don't discard the real unextracted content"
    // contract as expandMembers's own depth-capped result — see
    // finalizeTransparentContainer's comment.
    await finalizeTransparentContainer({ orgId, documentId, s3Key, result: { succeeded: 0, failures: [], depthCapped: true } });
    return;
  }

  const tempFilePath = join(tmpdir(), `pst-ingest-${documentId}.pst`);
  let messageCount = 0;
  const failures: MemberFailure[] = [];

  try {
    const object = await s3Client.send(new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: s3Key }));
    await pipeline(object.Body as Readable, createWriteStream(tempFilePath));

    for await (const message of iteratePstMessages(tempFilePath)) {
      const filename = `${(message.subject || "(no subject)").replace(/[\\/:*?"<>|]/g, "_").slice(0, 200)}.eml`;
      try {
        const { childDocumentId, familyDocumentId: messageFamilyDocumentId } = await withOrgSession(orgId, async (client) => {
          const childDocumentId = randomUUID();
          const guidNumber = await nextMatterGuid(client, matterId);
          // Transparent-container pass-through — see containerPassThrough's
          // own comment. The PST itself is elided: a message lands at the
          // SAME depth/parent/family the PST itself occupied, not one
          // level "inside" it.
          const passThrough = containerPassThrough({ parentDocumentId, familyDocumentId }, childDocumentId);

          await client.query(
            `INSERT INTO documents (id, org_id, matter_id, parent_document_id, family_document_id, depth, guid_number, original_filename, extension, size_bytes, s3_key, content_type_detected, ingest_status, title, author, subject, doc_date, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'eml', $9, NULL, 'eml', 'ready', $10, $11, $10, $12, $13)`,
            [
              childDocumentId,
              orgId,
              matterId,
              passThrough.parentDocumentId,
              passThrough.familyDocumentId,
              depth,
              guidNumber,
              filename,
              // The real PR_MESSAGE_SIZE property (pst.ts's sizeBytes,
              // sourced from message.messageSize) — the real accounted
              // size, not content.byteLength of some other reconstruction.
              message.sizeBytes,
              message.subject,
              message.from,
              message.date,
              JSON.stringify({
                to: message.to,
                cc: message.cc,
                bodyText: message.bodyText,
                bodyHtml: message.bodyHtml,
                attachmentFilenames: message.attachmentFilenames,
                source: "pst",
                folderPath: message.folderPath,
                messageClass: message.messageClass,
              }),
            ],
          );

          return { childDocumentId, familyDocumentId: passThrough.familyDocumentId };
        });

        // The message itself IS a real node — its own attachments are its
        // real children, one level deeper, via the exact same shared
        // primitive real .eml/.msg uploads use. Runs after the message's
        // own row has committed — see this function's own top comment for
        // why.
        await expandRealNodeAttachments({
          orgId,
          matterId,
          parent: { id: childDocumentId, familyDocumentId: messageFamilyDocumentId, depth },
          attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content })),
        });
        messageCount++;
      } catch (err) {
        // One bad message must never abort the rest of the PST.
        const errMessage = err instanceof Error ? err.message : String(err);
        console.error(`handlePstIngest: failed to expand a message from PST ${documentId}:`, err);
        failures.push({ filename, error: errMessage });
      }
    }

    await finalizeTransparentContainer({
      orgId,
      documentId,
      s3Key,
      result: { succeeded: messageCount, failures, depthCapped: false },
    });
  } catch (err) {
    // The PST itself couldn't be opened/streamed at all (missing S3
    // object, genuinely corrupt file — pst-extractor's own documented
    // limitation) — the parent document is marked failed, same as every
    // other content type's failure path.
    const message = sanitizeForPostgresText(err instanceof Error ? err.message : String(err));
    await markContainerFailed(orgId, documentId, message);
  } finally {
    await unlink(tempFilePath).catch(() => {
      // Best-effort cleanup — a failed unlink (e.g. the write itself never
      // created the file) must never mask whatever the real outcome above
      // already was.
    });
  }
}
