import "dotenv/config";
import { runOnce } from "./extraction/processJobs.js";

const POLL_INTERVAL_MS = 1000;

// Local-dev stand-in for the autoscaled ECS extraction worker fleet
// (Section 8.1) — same job-processing logic (src/extraction/processJobs.ts),
// just a plain poll loop instead of SQS-triggered autoscaling.
async function loop() {
  console.log("extraction worker started, polling for jobs...");
  for (;;) {
    const processed = await runOnce();
    if (!processed) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

loop().catch((err) => {
  console.error(err);
  process.exit(1);
});
