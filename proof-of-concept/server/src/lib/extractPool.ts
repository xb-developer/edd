import Piscina from "piscina";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtractedMetadata } from "./metadata.js";
import type { ExtractTask } from "../workers/extract-worker.js";

// Leave a couple of cores for the Electron UI thread, the main Node event
// loop, and Ollama's own inference — using every last core for extraction
// just makes the app feel frozen while it's "fast".
const POOL_SIZE = Math.max(1, os.cpus().length - 2);

const EMPTY: ExtractedMetadata = {
  title: null,
  author: null,
  subject: null,
  dateCreated: null,
  dateModified: null,
  to: null,
  cc: null,
  extra: null,
  text: null,
};

const pool = new Piscina({
  filename: fileURLToPath(new URL("../workers/extract-worker.ts", import.meta.url)),
  // The worker is TypeScript, loaded the same way the rest of the server
  // runs in dev — via tsx's ESM loader hook, registered in the worker
  // thread's own Node instance.
  execArgv: ["--import", "tsx/esm"],
  maxThreads: POOL_SIZE,
});

export async function extractInPool(filePath: string, extension: string): Promise<ExtractedMetadata> {
  try {
    return await pool.run({ filePath, extension } satisfies ExtractTask);
  } catch (err) {
    console.warn(`Worker extraction failed for ${filePath}: ${(err as Error).message}`);
    return EMPTY;
  }
}

export function getExtractPoolSize(): number {
  return POOL_SIZE;
}
