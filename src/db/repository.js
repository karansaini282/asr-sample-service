import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "../config.js";
import { DynamicQueryBuilder } from "./query-builder.js";

export class JobRepository {
  constructor(dbPath = CONFIG.DB_PATH) {
    this.dbPath = dbPath;

    // Ensure directory exists if using file path
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(dbPath);
    this._initPragmas();
    this._initSchema();
  }

  _initPragmas() {
    if (this.dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    }
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        job_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS job_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        audio_path TEXT NOT NULL,
        chunk_status TEXT NOT NULL,
        transcript_text TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        locked_by TEXT,
        locked_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_search ON jobs(user_id, job_status);
      CREATE INDEX IF NOT EXISTS idx_chunks_job ON job_chunks(job_id, chunk_index);
      CREATE INDEX IF NOT EXISTS idx_chunks_status ON job_chunks(chunk_status, locked_at);
    `);
  }

  createJob(jobId, userId, audioChunkPaths) {
    const now = new Date().toISOString();

    const insertJob = this.db.prepare(`
      INSERT INTO jobs (job_id, user_id, job_status, created_at)
      VALUES (?, ?, 'PENDING', ?)
    `);

    const insertChunk = this.db.prepare(`
      INSERT INTO job_chunks (job_id, chunk_index, audio_path, chunk_status, updated_at)
      VALUES (?, ?, ?, 'PENDING', ?)
    `);

    // In SQLite, executing statements sequentially in transaction
    this.db.exec("BEGIN TRANSACTION;");
    try {
      insertJob.run(jobId, userId, now);
      for (let i = 0; i < audioChunkPaths.length; i++) {
        insertChunk.run(jobId, i, audioChunkPaths[i], now);
      }
      this.db.exec("COMMIT;");
      return this.getJobWithChunks(jobId);
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  getJobWithChunks(jobId) {
    const jobStmt = this.db.prepare(`
      SELECT job_id, user_id, job_status, created_at, completed_at
      FROM jobs
      WHERE job_id = ?
    `);
    const job = jobStmt.get(jobId);
    if (!job) return null;

    const chunksStmt = this.db.prepare(`
      SELECT id, job_id, chunk_index, audio_path, chunk_status, transcript_text, error_message, retry_count, locked_by, locked_at, updated_at
      FROM job_chunks
      WHERE job_id = ?
      ORDER BY chunk_index ASC
    `);
    const chunks = chunksStmt.all(jobId);

    return {
      ...job,
      chunks,
    };
  }

  updateChunkStatus(chunkId, { status, transcriptText = null, errorMessage = null, retryCount = null, lockedBy = null, lockedAt = null }) {
    const now = new Date().toISOString();
    let query = `UPDATE job_chunks SET chunk_status = ?, updated_at = ?`;
    const params = [status, now];

    if (transcriptText !== null) {
      query += `, transcript_text = ?`;
      params.push(transcriptText);
    }
    if (errorMessage !== null) {
      query += `, error_message = ?`;
      params.push(errorMessage);
    }
    if (retryCount !== null) {
      query += `, retry_count = ?`;
      params.push(retryCount);
    }
    query += `, locked_by = ?, locked_at = ?`;
    params.push(lockedBy, lockedAt);

    query += ` WHERE id = ?`;
    params.push(chunkId);

    const stmt = this.db.prepare(query);
    stmt.run(...params);
  }

  updateJobStatus(jobId, status, completedAt = null) {
    const stmt = this.db.prepare(`
      UPDATE jobs
      SET job_status = ?, completed_at = COALESCE(?, completed_at)
      WHERE job_id = ?
    `);
    stmt.run(status, completedAt, jobId);
  }

  leasePendingChunks(workerId, limit = 50, leaseTimeoutSec = CONFIG.WORKER_LEASE_TIMEOUT_SEC) {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiredThresholdIso = new Date(now.getTime() - leaseTimeoutSec * 1000).toISOString();

    this.db.exec("BEGIN TRANSACTION;");
    try {
      // Find eligible chunks: PENDING, or PROCESSING with expired lock
      const selectStmt = this.db.prepare(`
        SELECT id, job_id, chunk_index, audio_path, chunk_status, retry_count
        FROM job_chunks
        WHERE chunk_status = 'PENDING'
           OR (chunk_status = 'PROCESSING' AND (locked_at IS NULL OR locked_at < ?))
        ORDER BY id ASC
        LIMIT ?
      `);
      const eligibleChunks = selectStmt.all(expiredThresholdIso, limit);

      if (eligibleChunks.length === 0) {
        this.db.exec("COMMIT;");
        return [];
      }

      const updateStmt = this.db.prepare(`
        UPDATE job_chunks
        SET chunk_status = 'PROCESSING', locked_by = ?, locked_at = ?, updated_at = ?
        WHERE id = ?
      `);

      const updateJobStmt = this.db.prepare(`
        UPDATE jobs
        SET job_status = 'PROCESSING'
        WHERE job_id = ? AND job_status = 'PENDING'
      `);

      for (const chunk of eligibleChunks) {
        updateStmt.run(workerId, nowIso, nowIso, chunk.id);
        updateJobStmt.run(chunk.job_id);
      }

      this.db.exec("COMMIT;");
      return eligibleChunks;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  searchJobs({ userId, jobStatus, limit = 50 } = {}) {
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);

    const builder = new DynamicQueryBuilder(`
      SELECT job_id, user_id, job_status, created_at, completed_at
      FROM jobs
    `);

    builder
      .whereIf(Boolean(userId), "user_id = ?", userId)
      .whereIf(Boolean(jobStatus), "job_status = ?", jobStatus)
      .orderBy("created_at DESC")
      .limit(safeLimit);

    const { sql, params } = builder.build();

    const stmt = this.db.prepare(sql);
    const jobs = stmt.all(...params);

    return jobs.map((job) => this.getJobWithChunks(job.job_id));
  }

  findUnfinishedJobs() {
    const stmt = this.db.prepare(`
      SELECT job_id, user_id, job_status, created_at, completed_at
      FROM jobs
      WHERE job_status IN ('PENDING', 'PROCESSING')
      ORDER BY created_at ASC
    `);
    const unfinished = stmt.all();
    return unfinished.map((job) => this.getJobWithChunks(job.job_id));
  }

  close() {
    try {
      this.db.close();
    } catch (_) {}
  }
}

// Default singleton repository
export const defaultRepository = new JobRepository();
