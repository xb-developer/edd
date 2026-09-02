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
export async function embedTexts(texts: string[]): Promise<number[][]> {
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

  const { data } = (await res.json()) as EmbeddingApiResponse;
  // The API is documented to preserve input order, but sorting by the
  // response's own `index` is cheap insurance against relying on that
  // rather than an explicitly-stated guarantee.
  return [...data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
}
