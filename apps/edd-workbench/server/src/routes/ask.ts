import { Router, type Request } from "express";
import { withOrgSession, embedTexts, generateAnswer, formatGuid, toVectorLiteral, recordAiUsage } from "@xbundle/edd-workbench-core";

// mergeParams — mounted at /api/matters/:matterId/ask (see index.ts),
// behind the same requireMatterAccess() gate as every other :matterId
// router — no new auth code needed.
export const askRouter = Router({ mergeParams: true });

// Both tunable, unvalidated-in-production defaults — revisit once there's
// real usage to tune against, same caveat chunking.ts's own chunk size
// already carries.
const RETRIEVAL_LIMIT = 12;
const MAX_COSINE_DISTANCE = 0.5;

const GPU_UNAVAILABLE_MESSAGE = "The AI service is only available 7am–19:00 UK time, Monday–Friday. Please try again during that window.";

interface RetrievedChunkRow {
  document_id: string;
  text: string;
  distance: number;
  guid_number: number;
  original_filename: string;
}

askRouter.post("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const { matterId } = req.params;
    const { question } = req.body as { question?: string };
    if (!question?.trim()) {
      res.status(400).json({ error: "question is required" });
      return;
    }

    // Embedding and generation only ever run Mon-Fri 7am-19:00 UK (see
    // GenerationService/EmbeddingService's own EventBridge schedules) —
    // unlike the async ingest->embedding queue hand-off, which tolerates a
    // cold/off GPU via SQS retry, this is a synchronous HTTP request with
    // no equivalent safety net, so a failure here gets a clear, specific
    // message rather than a generic 500.
    let questionEmbedding: number[];
    try {
      const { embeddings, totalTokens } = await embedTexts([question]);
      [questionEmbedding] = embeddings;
      await recordAiUsage(orgId, userId, "ask", totalTokens);
    } catch {
      res.status(503).json({ error: GPU_UNAVAILABLE_MESSAGE });
      return;
    }

    // matter_id, not just org_id, scopes this query — the whole point of
    // this feature is per-matter isolation, a narrower guarantee than the
    // org-wide isolation withOrgSession/RLS already gives every query.
    // `<=>` (cosine distance) matches document_chunks_embedding_hnsw_idx's
    // own `vector_cosine_ops` operator class (migration 026) — `<->` (L2)
    // would silently skip that index.
    const rows = await withOrgSession(orgId, (client) =>
      client.query<RetrievedChunkRow>(
        `SELECT dc.document_id, dc.text, dc.embedding <=> $2::vector AS distance, d.guid_number, d.original_filename
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.matter_id = $1
         ORDER BY dc.embedding <=> $2::vector
         LIMIT $3`,
        [matterId, toVectorLiteral(questionEmbedding), RETRIEVAL_LIMIT],
      ),
    );

    // Which documents are relevant is decided here, deterministically, by
    // retrieval — not left to the generation model to also get right. A
    // question with nothing genuinely close in this matter returns "no
    // relevant documents" instead of forcing an answer out of whatever the
    // least-bad matches happen to be.
    const relevantChunks = rows.rows.filter((row) => row.distance <= MAX_COSINE_DISTANCE);
    if (relevantChunks.length === 0) {
      res.json({ answer: "No relevant documents found for this question.", relevantDocuments: [] });
      return;
    }

    const documentsByid = new Map<string, { guid: string; filename: string }>();
    for (const chunk of relevantChunks) {
      if (!documentsByid.has(chunk.document_id)) {
        documentsByid.set(chunk.document_id, { guid: formatGuid(chunk.guid_number), filename: chunk.original_filename });
      }
    }

    const excerpts = relevantChunks
      .map((chunk) => `[Document ${formatGuid(chunk.guid_number)} – ${chunk.original_filename}]\n${chunk.text}`)
      .join("\n\n");

    let answer: string;
    try {
      const generated = await generateAnswer([
        {
          role: "system",
          content:
            "You are a legal document review assistant. Answer the question using ONLY the excerpts below, citing documents by name. Keep the answer short (2-4 sentences). If the excerpts don't actually answer the question, say so plainly instead of guessing.",
        },
        { role: "user", content: `Question: ${question}\n\nExcerpts:\n${excerpts}` },
      ]);
      answer = generated.content;
      await recordAiUsage(orgId, userId, "summarization", generated.totalTokens);
    } catch {
      res.status(503).json({ error: GPU_UNAVAILABLE_MESSAGE });
      return;
    }

    res.json({
      answer,
      relevantDocuments: [...documentsByid.entries()].map(([documentId, info]) => ({
        documentId,
        guid: info.guid,
        filename: info.filename,
      })),
    });
  } catch (err) {
    next(err);
  }
});
