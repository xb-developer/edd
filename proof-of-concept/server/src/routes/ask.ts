import { Router } from "express";
import { getDb, getAllChunks, type DocumentRow, type StoredChunk } from "../db.js";
import { embed, generate } from "../lib/ollama.js";

export const askRouter = Router();

// Ollama's default runtime context window for this model is 4096 tokens
// (confirmed via /api/ps) — 8 chunks at up to ~750 tokens each could exceed
// that and get silently truncated, on top of being slower to evaluate on
// CPU-only hardware than it needs to be. 4 keeps total context comfortably
// inside the window.
const TOP_K = 4;

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

interface AskResponse {
  answer: string;
  sources: Array<{ guid: string; originalName: string; snippet: string }>;
}

askRouter.post("/", async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) return res.status(400).json({ error: "question is required" });

  const allChunks = getAllChunks();
  if (allChunks.length === 0) {
    return res.status(400).json({
      error: "Nothing indexed yet for this matter. Import some documents first — indexing happens automatically as long as Ollama is running.",
    });
  }

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embed(question);
  } catch (err) {
    return res.status(503).json({ error: `Could not reach Ollama for embeddings: ${(err as Error).message}` });
  }

  const scored: Array<StoredChunk & { score: number }> = allChunks
    .map((c) => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  const db = getDb();
  const docByGuid = new Map<string, DocumentRow>();
  for (const c of scored) {
    if (docByGuid.has(c.guid)) continue;
    const row = db.prepare("SELECT * FROM documents WHERE guid = ?").get(c.guid) as DocumentRow | undefined;
    if (row) docByGuid.set(c.guid, row);
  }

  const context = scored
    .map((c) => `[${c.guid}] (${docByGuid.get(c.guid)?.original_name ?? "unknown"})\n${c.text}`)
    .join("\n\n---\n\n");

  const prompt = `You are a document review assistant helping a lawyer search a disclosure set. Answer the question using ONLY the excerpts below — do not use outside knowledge. Every factual claim in your answer must be immediately followed by the GUID of the excerpt it came from, in square brackets, e.g. [000012]. If the excerpts don't contain enough information to answer, say so plainly instead of guessing.

Excerpts:
${context}

Question: ${question}

Answer:`;

  let answer: string;
  try {
    answer = await generate(prompt);
  } catch (err) {
    return res.status(503).json({ error: `Could not reach Ollama for generation: ${(err as Error).message}` });
  }

  const uniqueGuids = Array.from(new Set(scored.map((c) => c.guid)));
  const citedGuids = uniqueGuids.filter((g) => answer.includes(g));
  const sourceGuids = citedGuids.length > 0 ? citedGuids : uniqueGuids;

  const sources = sourceGuids.map((g) => {
    const doc = docByGuid.get(g);
    const chunk = scored.find((c) => c.guid === g);
    return {
      guid: g,
      originalName: doc?.original_name ?? g,
      snippet: (chunk?.text ?? "").slice(0, 220),
    };
  });

  const response: AskResponse = { answer, sources };
  res.json(response);
});
