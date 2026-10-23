import { defaultJobService } from "../services/job-service.js";
import { defaultWorkerPool } from "../worker/worker-pool.js";
import { defaultLimiter } from "../services/concurrency-limiter.js";

export async function registerTranscriptionRoutes(fastify, options = {}) {
  const jobService = options.jobService || defaultJobService;
  const workerPool = options.workerPool || defaultWorkerPool;
  const limiter = options.limiter || defaultLimiter;

  // POST /transcribe
  fastify.post("/transcribe", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "Invalid request payload. Expected JSON object." });
    }

    const { audioChunkPaths, userId } = body;

    if (!userId || typeof userId !== "string") {
      return reply.code(400).send({ error: "Missing or invalid 'userId'. Must be a non-empty string." });
    }

    if (!Array.isArray(audioChunkPaths) || audioChunkPaths.length === 0) {
      return reply.code(400).send({ error: "Missing or invalid 'audioChunkPaths'. Must be a non-empty array of strings." });
    }

    for (const p of audioChunkPaths) {
      if (typeof p !== "string" || !p.trim()) {
        return reply.code(400).send({ error: "Each path in 'audioChunkPaths' must be a non-empty string." });
      }
    }

    try {
      const { jobId } = jobService.createJob(userId, audioChunkPaths);

      // Trigger background worker fan-out non-blockingly
      workerPool.processJob(jobId).catch((err) => {
        fastify.log.error(`Background processing failed for ${jobId}:`, err);
      });

      return reply.code(201).send({ jobId });
    } catch (err) {
      fastify.log.error("Failed to create transcription job:", err);
      return reply.code(500).send({ error: err.message || "Failed to create job" });
    }
  });

  // GET /transcript/search (Must be registered before /transcript/:jobId to prevent path collision)
  fastify.get("/transcript/search", async (request, reply) => {
    const { userId, jobStatus, limit } = request.query || {};

    try {
      const results = jobService.searchTranscripts({ userId, jobStatus, limit });
      return reply.code(200).send(results);
    } catch (err) {
      fastify.log.error("Search failed:", err);
      return reply.code(500).send({ error: err.message || "Failed to search transcripts" });
    }
  });

  // GET /transcript/:jobId
  fastify.get("/transcript/:jobId", async (request, reply) => {
    const { jobId } = request.params;
    if (!jobId) {
      return reply.code(400).send({ error: "Missing jobId parameter" });
    }

    try {
      const result = jobService.getTranscriptResult(jobId);
      if (!result) {
        return reply.code(404).send({ error: `Job not found: ${jobId}` });
      }

      return reply.code(200).send(result);
    } catch (err) {
      fastify.log.error(`Failed to fetch job ${jobId}:`, err);
      return reply.code(500).send({ error: err.message || "Failed to retrieve transcript" });
    }
  });

  // GET /api/metrics (Observability: Concurrency Limiter & Worker stats)
  fastify.get("/api/metrics", async (request, reply) => {
    return reply.code(200).send({
      service: "Ambience Backend Audio Transcription Service",
      concurrency: limiter.getMetrics(),
    });
  });
}
