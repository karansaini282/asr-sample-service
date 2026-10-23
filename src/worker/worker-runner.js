import { WorkerPool } from "./worker-pool.js";
import { defaultLimiter } from "../services/concurrency-limiter.js";
import { createChildLogger } from "../logger.js";

const logger = createChildLogger("WorkerDaemon");

logger.info("Initializing standalone transcription worker process...");

const worker = new WorkerPool();
await worker.startPolling();

logger.info(
  {
    workerId: worker.workerId,
    concurrencyCap: defaultLimiter.maxConcurrency,
  },
  "Worker process active and listening for queued jobs"
);

// Handle graceful shutdown
const shutdown = async (signal) => {
  logger.info({ signal }, "Received shutdown signal; draining worker queue...");
  await worker.stop();
  logger.info("Worker process exited cleanly");
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
