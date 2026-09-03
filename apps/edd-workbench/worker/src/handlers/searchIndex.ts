import { withOrgSession, resolveEmbeddableText, formatGuid, indexDocument } from "@xbundle/edd-workbench-core";

interface SearchIndexMessage {
  documentId: string;
  orgId: string;
}

interface DocumentRow {
  matter_id: string;
  original_filename: string;
  extension: string;
  content_type_detected: string;
  metadata: Record<string, unknown> | null;
  guid_number: number;
}

/**
 * Handles one { documentId, orgId } message off the search-index queue.
 * Enqueued from every terminal ingest state — ingest.ts's per-content-type
 * 'ready' branches and its own 'failed' catch, containerExpansion.ts's
 * surviving-row cases, and ocrQueue.ts's success/failure branches — not
 * just the success path, because today's filename search doesn't gate on
 * ingest_status and this replacement search must not regress that.
 *
 * Unlike embedding.ts, resolveEmbeddableText's result is NOT an eligibility
 * gate here — every document gets a search-index entry, even an excluded
 * type like xlsx (body just ends up empty), so it stays filename-searchable
 * the same way it is today.
 */
export async function handleSearchIndexMessage(body: string): Promise<void> {
  const { documentId, orgId } = JSON.parse(body) as SearchIndexMessage;

  const doc = await withOrgSession(orgId, async (client) => {
    const rows = await client.query<DocumentRow>(
      "SELECT matter_id, original_filename, extension, content_type_detected, metadata, guid_number FROM documents WHERE id = $1",
      [documentId],
    );
    return rows.rows[0] ?? null;
  });
  // Document deleted between being enqueued and this message being picked
  // up — nothing to do, not an error (same precedent as embedding.ts).
  if (!doc) return;

  await indexDocument({
    documentId,
    orgId,
    matterId: doc.matter_id,
    filename: doc.original_filename,
    extension: doc.extension,
    guid: formatGuid(doc.guid_number),
    body: resolveEmbeddableText(doc.content_type_detected, doc.metadata) ?? "",
  });
}
