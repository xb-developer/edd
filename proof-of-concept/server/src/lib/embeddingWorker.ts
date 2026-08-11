import {
  dequeueEmbeddingBatch,
  removeFromEmbeddingQueue,
  bumpEmbeddingAttempts,
  saveChunks,
  getActiveMatter,
} from "../db.js";
import { chunkText } from "./chunk.js";
import { embed } from "./ollama.js";

// Matches a sane default for Ollama's own concurrent-request slots
// (OLLAMA_NUM_PARALLEL) — sending more than Ollama will actually run at
// once just queues up on its side for no benefit.
const BATCH_SIZE = 3;
const POLL_INTERVAL_MS = 2000;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function processOne(item: { guid: string; text: string }): Promise<void> {
  try {
    const chunks = chunkText(item.text);
    if (chunks.length === 0) {
      removeFromEmbeddingQueue(item.guid);
      return;
    }
    const embedded = await Promise.all(
      chunks.map(async (c) => ({ index: c.index, text: c.text, embedding: await embed(c.text) })),
    );
    saveChunks(item.guid, embedded);
    removeFromEmbeddingQueue(item.guid);
  } catch (err) {
    console.warn(`Background embedding failed for ${item.guid} (is Ollama running?): ${(err as Error).message}`);
    bumpEmbeddingAttempts(item.guid);
  }
}

async function tick(): Promise<void> {
  if (ticking || !getActiveMatter()) return;
  ticking = true;
  try {
    const batch = dequeueEmbeddingBatch(BATCH_SIZE);
    if (batch.length > 0) await Promise.all(batch.map(processOne));
  } catch (err) {
    // Most likely a matter switch landed mid-tick — just skip this pass.
    console.warn(`Embedding queue tick skipped: ${(err as Error).message}`);
  } finally {
    ticking = false;
  }
}

export function startEmbeddingWorker(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref?.();
}
