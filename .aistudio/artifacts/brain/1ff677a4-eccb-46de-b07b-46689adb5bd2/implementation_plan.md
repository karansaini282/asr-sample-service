# Architectural Refactoring Plan: Uniform Business Logic Distribution

This plan establishes a strict separation of concerns following Domain-Driven Design (DDD) and Clean Architecture principles: all domain state transitions and data persistence are encapsulated within `JobService`, while `WorkerPool` is refined into a pure execution and concurrency orchestrator with zero direct database repository access.

---

> [!IMPORTANT]
> ## User Confirmed Architectural Directives
> 
> 1. **Complete State Delegation to `JobService`**:
>    - `JobService` will be the exclusive owner of all state transitions for both `jobs` and `job_chunks` (creating, claiming, recording success/failure, leasing, and finalization).
> 2. **Complete Decoupling of `WorkerPool` from `JobRepository`**:
>    - Remove `JobRepository` from `WorkerPool` entirely. `WorkerPool` will interact exclusively with `JobService` and `AsrClient`.
>    - `WorkerPool` has no knowledge of SQL tables, column names, or raw database mutations.

---

## 1. Domain Separation of Responsibilities

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Fastify API Gateway                             │
│                      (POST /transcribe, GET ...)                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Invokes
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                              JobService                                │
│       [The Authoritative Domain & Business Logic Orchestrator]         │
│                                                                        │
│  - createJob(userId, audioPaths)                                       │
│  - markJobProcessing(jobId)                                            │
│  - getIncompleteChunks(jobId)                                          │
│  - claimChunk(chunkId, workerId)                                       │
│  - recordChunkSuccess(chunkId, { transcript, attempts })               │
│  - recordChunkFailure(chunkId, { error, attempts })                    │
│  - finalizeJob(jobId)                                                  │
│  - leasePendingChunks(workerId, limit)                                 │
│  - findUnfinishedJobs()                                                │
│  - getTranscriptResult(jobId) / searchTranscripts(...)                 │
└───────────────────┬────────────────────────────────▲───────────────────┘
                    │                                │
    Exclusive Owner │ SQL Queries                    │ Informs state changes
    of Persistence  │ & Updates                      │ (claim, success, failure)
                    ▼                                │
┌──────────────────────────────────────┐  ┌──────────┴───────────────────┐
│            JobRepository             │  │          WorkerPool          │
│       (SQLite WAL / SQL Tables)      │  │  [Pure Execution Coordinator]│
│  - Raw SQL queries & table schemas   │  │                              │
│  - jobs & job_chunks tables          │  │  - Concurrent Chunk Fan-Out  │
└──────────────────────────────────────┘  │  - Acquires ASR Permits      │
                                          │  - Zero Database Knowledge   │
                                          └──────────────┬───────────────┘
                                                         │ Dispatches HTTP
                                                         ▼
                                          ┌──────────────────────────────┐
                                          │          AsrClient           │
                                          │   (Concurrency <= 100)       │
                                          └──────────────────────────────┘
```

---

## 2. Refactoring Specification

### 2.1 Enhancing `JobService` (`src/services/job-service.js`)
Extend `JobService` with clean chunk and lifecycle domain methods:
- `markJobProcessing(jobId)`: Transitions job status to `PROCESSING`.
- `getIncompleteChunks(jobId)`: Returns only chunks needing transcription (`PENDING` or incomplete).
- `claimChunk(chunkId, workerId)`: Transitions chunk to `PROCESSING` with worker lock and timestamp.
- `recordChunkSuccess(chunkId, { transcript, attempts })`: Transitions chunk to `COMPLETED`, stores text, records retry count.
- `recordChunkFailure(chunkId, { error, attempts })`: Transitions chunk to `FAILED`, stores error message, records retry count.
- `leasePendingChunks(workerId, limit)`: Encapsulates database worker queue leasing.
- `findUnfinishedJobs()`: Encapsulates restart recovery queries.

### 2.2 Purifying `WorkerPool` (`src/worker/worker-pool.js`)
- **Constructor**: Remove `repository`. Accept only `jobService`, `asrClient`, and optional `workerId`.
- **`processJob(jobId)`**:
  1. Calls `await this.jobService.markJobProcessing(jobId)`.
  2. Calls `const chunks = await this.jobService.getIncompleteChunks(jobId)`.
  3. Dispatches chunks concurrently via `Promise.allSettled`:
     - `await this.jobService.claimChunk(chunk.id, this.workerId)`.
     - `const outcome = await this.asrClient.transcribeChunk(chunk.audio_path)`.
     - `if (outcome.success) await this.jobService.recordChunkSuccess(chunk.id, outcome)`.
     - `else await this.jobService.recordChunkFailure(chunk.id, outcome)`.
  4. Calls `await this.jobService.finalizeJob(jobId)`.
- **`recoverUnfinishedJobs()`**: Calls `this.jobService.findUnfinishedJobs()`.
- **`startPolling()`**: Calls `this.jobService.leasePendingChunks(this.workerId, limit)`.

### 2.3 Updating Instantiations & Test Suite
- In `src/worker/worker-pool.js`, default `defaultWorkerPool` uses `defaultJobService`.
- In `src/tests/test-suite.js`, instantiate `WorkerPool` with `{ jobService: testJobService, asrClient: testAsrClient }` (no repository passed).
- Update `TECHNICAL_DESIGN.md` architecture section to reflect the clean domain layer.

---

## 3. Verification Plan
- Run `npm test`: Verify all 5 automated test scenarios pass.
- Run `npm run lint` & `compile_applet`: Ensure clean TypeScript/Node syntax.
- Run `npm run demo`: Verify live interview walkthrough executes cleanly.
