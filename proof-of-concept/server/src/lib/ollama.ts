import { Agent, fetch } from "undici";

// Local-only LLM access — no document text or questions ever leave the
// machine. Requires Ollama running locally (default port) with these models
// pulled: `ollama pull nomic-embed-text` and `ollama pull llama3.1:8b`.
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
export const EMBED_MODEL = "nomic-embed-text";
export const CHAT_MODEL = "llama3.1:8b";

// Plain global fetch() pools connections to Ollama unbounded, and a request
// that gets aborted via AbortSignal.timeout() doesn't reliably tear its
// socket down — over a long-running session this silently piled up to
// hundreds of stale ESTABLISHED connections, which was itself enough to
// degrade Ollama's response time until every new request timed out too.
// A capped Agent with a short idle eviction closes what accumulates instead
// of letting it grow forever.
const ollamaAgent = new Agent({
  connections: 4,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
});

// Ollama has no built-in request timeout, and a busy/overloaded local model
// (e.g. concurrent imports, or a big generation already in flight) can leave
// a request hanging indefinitely. Bound it so a slow Ollama degrades
// gracefully (indexing/asking fails and is reported) instead of hanging the
// whole import — or the "Ask" request — forever.
const DEFAULT_EMBED_TIMEOUT_MS = 30_000;
// This machine has no dedicated GPU (Ollama reports size_vram: 0 for both
// models) — llama3.1:8b runs on CPU only. Measured directly against this
// machine: ~14.5 tokens/sec prompt evaluation, ~3.4 tokens/sec generation.
// A grounded 4-chunk answer (~3000 tokens of context, a few hundred tokens
// of generated answer) can genuinely take 5-6 minutes — this bounds the
// truly-stuck case without false-timeouting a normal slow answer.
const DEFAULT_GENERATE_TIMEOUT_MS = 420_000;

export async function embed(text: string, timeoutMs = DEFAULT_EMBED_TIMEOUT_MS): Promise<Float32Array> {
  const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: ollamaAgent,
  });
  if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status} ${res.statusText} — ${await res.text()}`);
  const data = (await res.json()) as { embedding: number[] };
  return Float32Array.from(data.embedding);
}

export async function generate(prompt: string, timeoutMs = DEFAULT_GENERATE_TIMEOUT_MS): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: CHAT_MODEL, prompt, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: ollamaAgent,
  });
  if (!res.ok) throw new Error(`Ollama generate failed: ${res.status} ${res.statusText} — ${await res.text()}`);
  const data = (await res.json()) as { response: string };
  return data.response;
}

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/version`);
    return res.ok;
  } catch {
    return false;
  }
}
