import { runOnce } from "../src/extraction/processJobs.js";

/**
 * Drains every currently-queued job, not just one. Tests share a single
 * Postgres jobs queue across files run in one process, so a single
 * runOnce() call isn't guaranteed to process the job a given test just
 * created — an unrelated leftover job from an earlier test can legitimately
 * be next in FIFO order (exactly the behavior a real worker fleet has too).
 * Draining fully is the only assumption that's actually safe to make.
 */
export async function drainJobs(maxIterations = 100): Promise<number> {
  let processed = 0;
  while (processed < maxIterations && (await runOnce())) {
    processed++;
  }
  return processed;
}
