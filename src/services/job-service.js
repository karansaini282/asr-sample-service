import crypto from "node:crypto";
import { defaultRepository } from "../db/repository.js";

export class JobService {
  constructor(repository = defaultRepository) {
    this.repository = repository;
  }

  generateJobId() {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString("hex");
    return `job_${timestamp}_${random}`;
  }

  createJob(userId, audioChunkPaths) {
    if (!userId || typeof userId !== "string") {
      throw new Error("userId is required and must be a string");
    }
    if (!Array.isArray(audioChunkPaths) || audioChunkPaths.length === 0) {
      throw new Error("audioChunkPaths must be a non-empty array of strings");
    }
    for (const p of audioChunkPaths) {
      if (typeof p !== "string" || !p.trim()) {
        throw new Error("Each audioChunkPath must be a non-empty string");
      }
    }

    const jobId = this.generateJobId();
    const jobRecord = this.repository.createJob(jobId, userId, audioChunkPaths);
    return {
      jobId,
      record: jobRecord,
    };
  }

  markJobProcessing(jobId) {
    this.repository.updateJobStatus(jobId, "PROCESSING");
  }

  getIncompleteChunks(jobId) {
    const jobWithChunks = this.repository.getJobWithChunks(jobId);
    if (!jobWithChunks || !jobWithChunks.chunks) {
      return { job: null, chunks: [] };
    }

    const incomplete = jobWithChunks.chunks.filter((c) => c.chunk_status !== "COMPLETED");
    return {
      job: jobWithChunks,
      chunks: incomplete,
      totalCount: jobWithChunks.chunks.length,
    };
  }

  claimChunk(chunkId, workerId) {
    const nowIso = new Date().toISOString();
    this.repository.updateChunkStatus(chunkId, {
      status: "PROCESSING",
      lockedBy: workerId,
      lockedAt: nowIso,
    });
  }

  recordChunkSuccess(chunkId, { transcript, attempts = 1 }) {
    this.repository.updateChunkStatus(chunkId, {
      status: "COMPLETED",
      transcriptText: transcript,
      retryCount: Math.max(0, attempts - 1),
      lockedBy: null,
      lockedAt: null,
    });
  }

  recordChunkFailure(chunkId, { error, attempts = 1 }) {
    this.repository.updateChunkStatus(chunkId, {
      status: "FAILED",
      errorMessage: error,
      retryCount: attempts,
      lockedBy: null,
      lockedAt: null,
    });
  }

  finalizeJob(jobId) {
    const jobWithChunks = this.repository.getJobWithChunks(jobId);
    if (!jobWithChunks || !jobWithChunks.chunks) return null;

    const chunks = jobWithChunks.chunks;
    const failedCount = chunks.filter((c) => c.chunk_status === "FAILED").length;
    const pendingCount = chunks.filter((c) => c.chunk_status === "PENDING" || c.chunk_status === "PROCESSING").length;

    // If still have pending or processing chunks, leave in PROCESSING
    if (pendingCount > 0) {
      return "PROCESSING";
    }

    const completedAt = new Date().toISOString();
    let finalStatus = "COMPLETED";

    if (failedCount === chunks.length) {
      finalStatus = "FAILED";
    } else if (failedCount > 0) {
      finalStatus = "PARTIAL_SUCCESS";
    }

    this.repository.updateJobStatus(jobId, finalStatus, completedAt);
    return finalStatus;
  }

  findUnfinishedJobs() {
    return this.repository.findUnfinishedJobs();
  }

  leasePendingChunks(workerId, limit = 25) {
    return this.repository.leasePendingChunks(workerId, limit);
  }

  getTranscriptResult(jobId) {
    const jobWithChunks = this.repository.getJobWithChunks(jobId);
    if (!jobWithChunks) {
      return null;
    }

    return this.formatTranscriptResult(jobWithChunks);
  }

  searchTranscripts({ userId, jobStatus, limit } = {}) {
    const jobs = this.repository.searchJobs({ userId, jobStatus, limit });
    return jobs.map((job) => this.formatTranscriptResult(job));
  }

  formatTranscriptResult(jobWithChunks) {
    const chunkStatuses = {};
    const textSegments = [];

    const chunks = jobWithChunks.chunks || [];
    for (const chunk of chunks) {
      chunkStatuses[chunk.audio_path] = chunk.chunk_status;

      if (chunk.chunk_status === "COMPLETED" && chunk.transcript_text) {
        textSegments.push(chunk.transcript_text.trim());
      } else if (chunk.chunk_status === "FAILED") {
        textSegments.push(`[Transcript unavailable for ${chunk.audio_path}]`);
      }
    }

    return {
      jobId: jobWithChunks.job_id,
      jobStatus: jobWithChunks.job_status,
      completedTime: jobWithChunks.completed_at || null,
      transcriptText: textSegments.join("\n\n"),
      chunkStatuses,
    };
  }
}

// Global default job service
export const defaultJobService = new JobService();
