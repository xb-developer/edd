// Self-hosted Qwen3-4B served by vLLM, co-located with the embedding model
// on one instance (see infra/edd-workbench/lib/edd-workbench-stack.ts's
// GpuService) — only warm during the same scheduled business hours as the
// embedding model, so a call made outside that window (or during any other
// GPU-service failure) will fail/time out; the caller (ask.ts) turns that
// into a generic "temporarily unavailable" response, not this client.
// Switched down from Qwen3-8B on 2026-09-08 specifically to fit alongside
// the embedding model on a single GPU — see ai-model-decision.md's
// "Investigation: smaller models" section for the quality tradeoff this
// accepts (not yet validated against real documents).
const GENERATION_MODEL = process.env.GENERATION_MODEL ?? "Qwen/Qwen3-4B";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices: { message: { content: string } }[];
  // Optional — defensive, not because vLLM's OpenAI-compatible endpoint
  // ever omits it in practice, but so a response shape change degrades to
  // "usage under-counted as 0" rather than a thrown exception.
  usage?: { total_tokens: number };
}

export interface GenerateAnswerResult {
  content: string;
  // prompt_tokens + completion_tokens for this one call — the full cost
  // of the request, not just what was generated.
  totalTokens: number;
}

/**
 * Calls vLLM's own OpenAI-compatible /v1/chat/completions endpoint
 * directly — same "no wrapper service of our own" reasoning as
 * embeddingClient.ts: vLLM's API already IS the stable, swappable
 * contract. Low temperature and a bounded max_tokens by default since
 * every current caller (ask.ts) wants a short, grounded answer, not
 * creative or long-form text.
 *
 * Reads GENERATION_SERVICE_URL lazily (not at module load), matching
 * embeddingClient.ts, so importing this module doesn't force every
 * importer to have the env var set.
 */
export async function generateAnswer(messages: ChatMessage[], options?: { maxTokens?: number; temperature?: number }): Promise<GenerateAnswerResult> {
  const serviceUrl = process.env.GENERATION_SERVICE_URL;
  if (!serviceUrl) {
    throw new Error("GENERATION_SERVICE_URL environment variable is required");
  }

  const res = await fetch(`${serviceUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GENERATION_MODEL,
      messages,
      max_tokens: options?.maxTokens ?? 400,
      temperature: options?.temperature ?? 0.1,
      // Qwen3 is a hybrid thinking/non-thinking model — without this, a
      // real verification call returned a raw <think>...</think>
      // reasoning trace that got cut off by max_tokens before ever
      // producing an actual answer. Confirmed against vLLM's own docs,
      // not guessed.
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Generation request failed: ${res.status} ${body}`);
  }

  const { choices, usage } = (await res.json()) as ChatCompletionResponse;
  return { content: choices[0]?.message.content?.trim() ?? "", totalTokens: usage?.total_tokens ?? 0 };
}
