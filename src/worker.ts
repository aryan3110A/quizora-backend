import pino from "pino";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { createFinalizerLoop } from "./services/finalizer";

// Quizora background worker: finalizes expired examination attempts.
// Same image as the API, different command (`npm run worker` / `node dist/src/worker.js`).
// Safe to run on every instance: see the concurrency notes in services/attempts.ts.
const logger = pino({ name: "quizora-worker" });
const loop = createFinalizerLoop({
  intervalMs: env.WORKER_POLL_INTERVAL_MS,
  batchSize: env.WORKER_BATCH_SIZE,
  logger
});

logger.info({ intervalMs: env.WORKER_POLL_INTERVAL_MS, batchSize: env.WORKER_BATCH_SIZE }, "worker started");
loop.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker shutting down");
  setTimeout(() => process.exit(1), 15_000).unref();
  await loop.stop();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ reason: String(reason) }, "unhandled rejection; exiting so the supervisor restarts the worker");
  process.exit(1);
});
