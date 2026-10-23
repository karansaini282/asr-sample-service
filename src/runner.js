import Fastify from "fastify";
import { registerAsrMockRoutes } from "./services/asr-mock-plugin.js";
import { registerTranscriptionRoutes } from "./api/routes.js";
import { defaultWorkerPool } from "./worker/worker-pool.js";
import { defaultLimiter } from "./services/concurrency-limiter.js";
import { defaultRepository } from "./db/repository.js";
import { TranscriptMocks } from "../mock-transcripts.js";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";

export async function createUnifiedServer(options = {}) {
  const fastify = Fastify({
    logger: options.logger !== undefined ? options.logger : logger,
  });

  // 1. Mount upstream ASR mock endpoint (/get-asr-output)
  registerAsrMockRoutes(fastify, options.asrMockOptions);

  // 2. Mount transcription service endpoints (/transcribe, /transcript/:jobId, /transcript/search)
  await registerTranscriptionRoutes(fastify, options);

  // 3. Welcome / health check endpoint
  fastify.get("/", async () => {
    return {
      service: "Ambience Healthcare Audio Transcription Service",
      status: "running",
      version: "1.0.0",
      documentation: "See TECHNICAL_DESIGN.md for architectural specifications",
      endpoints: {
        submitJob: "POST /transcribe (body: { audioChunkPaths: string[], userId: string })",
        getTranscript: "GET /transcript/:jobId",
        searchTranscripts: "GET /transcript/search?userId={id}&jobStatus={status}",
        metrics: "GET /api/metrics",
        upstreamMock: "GET /get-asr-output?path={audioFile}",
      },
      concurrencyCap: defaultLimiter.maxConcurrency,
      supportedAudioFiles: Array.from(TranscriptMocks.keys()),
    };
  });

  return fastify;
}

export async function startUnifiedService() {
  const server = await createUnifiedServer();

  // Run crash recovery for any in-flight jobs from previous process lifetimes
  await defaultWorkerPool.recoverUnfinishedJobs();

  try {
    await server.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
    logger.info(
      {
        host: CONFIG.HOST,
        port: CONFIG.PORT,
        concurrencyCap: CONFIG.MAX_CONCURRENT_ASR_REQUESTS,
      },
      "Unified Transcription Service successfully started"
    );
  } catch (err) {
    logger.error({ err: err.message }, "Failed to start server");
    process.exit(1);
  }

  // Graceful shutdown handling
  let isShuttingDown = false;
  const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, "Shutdown signal received; gracefully draining services...");

    try {
      await defaultWorkerPool.stop(5000);
      await server.close();
      defaultRepository.close();
      logger.info("All services shut down cleanly");
      process.exit(0);
    } catch (err) {
      logger.error({ err: err.message }, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

// Start if executed directly
if (process.argv[1] && process.argv[1].endsWith("runner.js")) {
  startUnifiedService();
}
