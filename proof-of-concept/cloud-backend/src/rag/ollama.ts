import { Agent, fetch as undiciFetch } from "undici";
import "dotenv/config";

// Plain global fetch() doesn't reliably close sockets on timeout/abort —
// the desktop prototype hit this for real (400+ stale connections over a
// long session degrading Ollama's response time). Must use undici's own
// fetch with a bounded Agent throughout; mixing global fetch with an
// imported undici Agent doesn't work (different dispatcher instances).
const agent = new Agent({ connections: 4, keepAliveTimeout: 10_000 });

const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const embedModel = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
const generateModel = process.env.OLLAMA_GENERATE_MODEL ?? "llama3.1:8b";

export async function embedText(text: string): Promise<number[]> {
  const res = await undiciFetch(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: embedModel, prompt: text }),
    dispatcher: agent,
  });
  if (!res.ok) throw new Error(`Ollama embeddings request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { embedding: number[] };
  return body.embedding;
}

export interface GenerateOptions {
  timeoutMs?: number;
}

export async function generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
  // CPU-only Ollama on this class of machine is genuinely slow (the desktop
  // prototype measured ~3.4 tok/s generation) — a grounded RAG answer can
  // legitimately take minutes, hence the generous default timeout.
  const res = await undiciFetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: generateModel, prompt, stream: false }),
    dispatcher: agent,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 420_000),
  });
  if (!res.ok) throw new Error(`Ollama generate request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { response: string };
  return body.response;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
