import crypto from "node:crypto";
import { defaultJobService } from "../services/job-service.js";
import { defaultAsrClient } from "../services/asr-client.js";
import { CONFIG } from "../config.js";
import { createChildLogger } from "../logger.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * WorkerPool: Pure Execution & Concurrency Orchestrator
 * Coordinates concurrent chunk transcription via AsrClient under strict rate limits.
 * All state mutations and persistence are delegated to JobService.
 */
export class WorkerPool {
  constructor(options = {}) {
    this.workerId = options.workerId || `worker_${crypto.randomBytes(4).toString("hex")}`;
    this.jobService = options.jobService || defaultJobService;
    this.asrClient = options.asrClient || defaultAsrClient;
    this.logger = createChildLogger("WorkerPool", { workerId: this.workerId });
    this.isRunning = false;
    this.inFlightJobs = new Set();
  }

  /**
   * Process all incomplete chunks in a single job in parallel (fan-out) to guarantee sub-20s latency.
   */
  async processJob(jobId) {
    this.jobService.markJobProcessing(jobId);
    const { chunks, totalCount } = this.jobService.getIncompleteChunks(jobId);
    if (!chunks || chunks.length === 0) {
      return;
    }

    this.inFlightJobs.add(jobId);
    this.logger.info({ jobId, totalCount, remainingChunks: chunks.length }, "Starting parallel chunk processing for job");

    const startTime = Date.now();

    // Fan-out: dispatch all incomplete chunks in parallel
    const promises = chunks.map(async (chunk) => {
      this.jobService.claimChunk(chunk.id, this.workerId);

      const outcome = await this.asrClient.transcribeChunk(chunk.audio_path);

      if (outcome.success) {
        this.logger.debug(
          { jobId, chunkIndex: chunk.chunk_index, audioPath: chunk.audio_path, attempts: outcome.attempts },
          "Chunk transcribed successfully"
        );
        this.jobService.recordChunkSuccess(chunk.id, outcome);
      } else {
        this.logger.warn(
          { jobId, chunkIndex: chunk.chunk_index, audioPath: chunk.audio_path, error: outcome.error, attempts: outcome.attempts },
          "Chunk transcription failed after retries"
        );
        this.jobService.recordChunkFailure(chunk.id, outcome);
      }
    });

    try {
      await Promise.allSettled(promises);
      const finalStatus = this.jobService.finalizeJob(jobId);
      const durationMs = Date.now() - startTime;
      this.logger.info({ jobId, finalStatus, durationMs }, "Job completed");
    } finally {
      this.inFlightJobs.delete(jobId);
    }
  }

  /**
   * Recovers any unfinished jobs from the service across server restarts.
   */
  async recoverUnfinishedJobs() {
    const unfinished = this.jobService.findUnfinishedJobs();
    if (unfinished.length === 0) return;

    this.logger.info({ count: unfinished.length }, "Found unfinished jobs across process restart; reconciling...");

    for (const job of unfinished) {
      this.processJob(job.job_id).catch((err) => {
        this.logger.error({ jobId: job.job_id, err: err.message }, "Error during restart job recovery");
      });
    }
  }

  /**
   * Start polling loop for standalone worker daemon mode (decoupled workers).
   */
  async startPolling() {
    this.isRunning = true;
    this.logger.info("Worker polling loop started");
    await this.recoverUnfinishedJobs();

    const loop = async () => {
      while (this.isRunning) {
        try {
          const leasedChunks = this.jobService.leasePendingChunks(this.workerId, 25);
          if (leasedChunks.length > 0) {
            const jobIds = [...new Set(leasedChunks.map((c) => c.job_id))];
            this.logger.debug({ jobCount: jobIds.length, chunkCount: leasedChunks.length }, "Leased pending chunks");
            await Promise.allSettled(jobIds.map((jid) => this.processJob(jid)));
          } else {
            await sleep(CONFIG.WORKER_POLL_INTERVAL_MS);
          }
        } catch (err) {
          this.logger.error({ err: err.message }, "Worker polling iteration encountered error");
          await sleep(CONFIG.WORKER_POLL_INTERVAL_MS * 2);
        }
      }
    };

    loop();
  }

  async stop(timeoutMs = 10000) {
    this.isRunning = false;
    this.logger.info({ inFlightCount: this.inFlightJobs.size }, "Stopping worker pool; waiting for in-flight tasks to drain");

    const deadline = Date.now() + timeoutMs;
    while (this.inFlightJobs.size > 0 && Date.now() < deadline) {
      await sleep(100);
    }
    this.logger.info("Worker pool stopped successfully");
  }
}

// Global default worker pool
export const defaultWorkerPool = new WorkerPool();
