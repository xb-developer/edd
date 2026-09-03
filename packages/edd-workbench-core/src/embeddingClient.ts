// Self-hosted Qwen3-Embedding-8B served by vLLM (see
// infra/edd-workbench/lib/edd-workbench-stack.ts's EmbeddingService) —
// only warm during scheduled business hours, so calls made outside that
// window will fail/time out until the next scheduled start; the embedding
// queue handler's own retry (via SQS's normal redelivery/DLQ) is what
// absorbs that, not this client.
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "Qwen/Qwen3-Embedding-8B";
// 1024 — must match document_chunks.embedding's vector(1024) column (see
// migration 026); Qwen3-Embedding-8B supports Matryoshka-style truncated
// output via this same `dimensions` request parameter.
const EMBEDDING_DIMENSIONS = 1024;

interface EmbeddingApiResponse {
  data: { embedding: number[]; index: number }[];
  // Optional — defensive, not because vLLM's OpenAI-compatible endpoint
  // ever omits it in practice, but so a response shape change degrades to
  // "usage under-counted as 0" rather than a thrown exception.
  usage?: { total_tokens: number };
}

export interface EmbedTextsResult {
  embeddings: number[][];
  // Sum of prompt tokens across every string in `texts` for this one
  // batched call — embeddings are encode-only, so there's no separate
  // completion-token count the way generation has.
  totalTokens: number;
}

/**
 * Calls vLLM's own OpenAI-compatible /v1/embeddings endpoint directly —
 * deliberately no wrapper service of our own around it (unlike
 * ocr-service's REST facade around Textract's more awkward async-job SDK
 * shape): vLLM's API already IS the stable, swappable contract here.
 * Swapping the underlying model/engine later means changing only this
 * file's request shape, not any caller.
 *
 * Reads EMBEDDING_SERVICE_URL lazily (not at module load) — this module
 * is imported by things that don't necessarily call it (e.g. tests of
 * other embedding-pipeline pieces), so it shouldn't force every importer
 * to have this env var set the way the worker/server apps' own
 * fail-fast-at-startup checks do for their own required vars.
 */
export async function embedTexts(texts: string[]): Promise<EmbedTextsResult> {
  const serviceUrl = process.env.EMBEDDING_SERVICE_URL;
  if (!serviceUrl) {
    throw new Error("EMBEDDING_SERVICE_URL environment variable is required");
  }

  const res = await fetch(`${serviceUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts, dimensions: EMBEDDING_DIMENSIONS }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding request failed: ${res.status} ${body}`);
  }

  const { data, usage } = (await res.json()) as EmbeddingApiResponse;
  // The API is documented to preserve input order, but sorting by the
  // response's own `index` is cheap insurance against relying on that
  // rather than an explicitly-stated guarantee.
  const embeddings = [...data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  return { embeddings, totalTokens: usage?.total_tokens ?? 0 };
}
