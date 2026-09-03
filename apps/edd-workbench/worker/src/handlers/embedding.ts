import { withOrgSession, resolveEmbeddableText, chunkText, embedTexts, replaceDocumentChunks, recordAiUsage } from "@xbundle/edd-workbench-core";

interface EmbeddingMessage {
  documentId: string;
  orgId: string;
}

interface DocumentRow {
  matter_id: string;
  content_type_detected: string;
  metadata: Record<string, unknown> | null;
  uploaded_by: string | null;
}

/**
 * Handles one { documentId, orgId } message off the embedding queue.
 * Enqueued from ingest.ts (once a document reaches ingest_status='ready')
 * and ocrQueue.ts (once OCR succeeds) — this handler, not the enqueue
 * site, is where eligibility is actually decided (via
 * resolveEmbeddableText), so every 'ready' document gets exactly one
 * enqueue call regardless of content type, and content types with nothing
 * embeddable (spreadsheets, pptx, empty documents) simply end up
 * 'excluded' here rather than needing their own special-cased skip logic
 * at each call site.
 *
 * Deliberately does NOT hold one DB transaction open across the embedding
 * call itself — same reasoning as ocrQueue.ts: the embedding service is a
 * self-hosted GPU instance that's only warm on a schedule (see the CDK
 * stack's EmbeddingService), so a call here can legitimately take from
 * seconds (warm) to minutes (cold-starting the instance) to fail outright
 * (outside the scheduled window) — a checked-out pool connection must
 * never sit idle-in-transaction for that long.
 */
export async function handleEmbeddingMessage(body: string): Promise<void> {
  const { documentId, orgId } = JSON.parse(body) as EmbeddingMessage;

  const doc = await withOrgSession(orgId, async (client) => {
    const rows = await client.query<DocumentRow>(
      "SELECT matter_id, content_type_detected, metadata, uploaded_by FROM documents WHERE id = $1",
      [documentId],
    );
    return rows.rows[0] ?? null;
  });
  // Document deleted between being enqueued and this message being picked
  // up — nothing to do, not an error.
  if (!doc) return;

  const text = resolveEmbeddableText(doc.content_type_detected, doc.metadata);
  if (!text) {
    await withOrgSession(orgId, (client) =>
      client.query("UPDATE documents SET embedding_status = 'excluded' WHERE id = $1", [documentId]),
    );
    return;
  }

  await withOrgSession(orgId, (client) =>
    client.query("UPDATE documents SET embedding_status = 'processing' WHERE id = $1", [documentId]),
  );

  try {
    const chunks = chunkText(text);
    const { embeddings, totalTokens } = await embedTexts(chunks);
    await withOrgSession(orgId, async (client) => {
      await replaceDocumentChunks(client, {
        orgId,
        matterId: doc.matter_id,
        documentId,
        chunks: chunks.map((chunk, i) => ({ text: chunk, embedding: embeddings[i] })),
      });
      await client.query("UPDATE documents SET embedding_status = 'ready' WHERE id = $1", [documentId]);
    });
    // Attributed to the uploader, not whoever's request happened to
    // trigger the async ingest->embedding hand-off — there usually isn't
    // one (SQS redelivery, a scheduled retry). Old rows predating
    // uploaded_by being populated simply aren't attributable to anyone.
    if (doc.uploaded_by) {
      await recordAiUsage(orgId, doc.uploaded_by, "embedding", totalTokens);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withOrgSession(orgId, (client) =>
      client.query("UPDATE documents SET embedding_status = 'failed', embedding_error = $1 WHERE id = $2", [message, documentId]),
    );
  }
}
