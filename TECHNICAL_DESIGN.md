# Technical Design Specification: Backend Audio Transcription Service

**Author**: Ambience Healthcare Engineering  
**Target Runtime**: Node.js 22 LTS  
**Architecture Type**: Asynchronous High-Throughput Microservice with Decoupled Worker Pool  

---

## 1. Executive Summary & Architecture Overview

This service implements an enterprise-grade, asynchronous backend system designed to ingest, transcribe, and stitch multi-chunk audio recordings of clinical patient-provider encounters (typically 30–120 minutes in duration, partitioned into chunks $\le 5$ minutes).

The architecture is built around four non-negotiable operational requirements:
1. **Strict Concurrency Cap ($\le 100$)**: The third-party ASR vendor enforces a hard rate limit of 100 simultaneous requests. Breaching this limit triggers HTTP 429 errors and risks vendor bans.
2. **Sub-20s Happy-Path Latency**: Ingested 30-minute encounters (6 chunks $\times$ 5 min) must transcribe and stitch into a single coherent transcript in under 20 seconds.
3. **Fault Tolerance & Graceful Degradation**: 5% of upstream requests fail transiently (HTTP 500). Some chunks (e.g., `audio-file-8.wav`) permanently fail. The service must retry transient errors with exponential backoff and randomized jitter, and degrade unrecoverable chunks into `PARTIAL_SUCCESS` without dropping completed audio segments.
4. **Crash Durability & Restart Recovery**: The system must persist all state authoritatively such that server or worker restarts resume in-flight jobs without loss or duplication.

```
                     SYSTEM ARCHITECTURE OVERVIEW

┌────────────────────────────────────────────────────────────────────────┐
│                        Clients / EMR Integrations                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP POST / GET
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Fastify API Gateway                             │
│  - POST /transcribe (Payload validation, UUID generation, 201 Created) │
│  - GET  /transcript/:jobId (Poll status, retrieve stitched transcript) │
│  - GET  /transcript/search (Historical index filter: userId/jobStatus) │
│  - GET  /api/metrics (Observability: active concurrency gauge & queue) │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Invokes
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                              JobService                                │
│       [The Authoritative Domain & Business Logic Orchestrator]         │
│  - Owns all Job & Chunk state transitions (create, claim, complete)    │
│  - Stitches transcripts & handles partial success markers              │
│  - Manages worker chunk leasing and crash recovery queries             │
└───────────────────┬────────────────────────────────▲───────────────────┘
                    │ Exclusive Owner of SQL Queries │ State Updates & Claims
                    ▼                                │
┌──────────────────────────────────────┐  ┌──────────┴───────────────────┐
│        Authoritative Data Store      │  │     Decoupled Worker Pool    │
│  (SQLite WAL / PostgreSQL Relational)│  │ [Pure Execution Orchestrator]│
│  - jobs & job_chunks tables          │  │ - Parallel Chunk Fan-Out     │
│  - B-Tree indexes & ACID durability  │  │ - Acquires Concurrency Slots │
└──────────────────────────────────────┘  │ - Zero Database Knowledge    │
                                          └──────────────┬───────────────┘
                                                         │ Requests permit (cap 100)
                                                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 Strict ASR Concurrency Limiter                         │
│  - Thread-safe / async semaphore with active slot counter (cap = 100)  │
│  - Queues excess chunk callers in FIFO wait-queue                      │
└────────────────────────────────────────────────────────────────────────┘
                    │ Slot acquired
                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    Resilient ASR Client                                │
│  - 3x Exponential Backoff with randomized jitter on transient 500      │
│  - Permanent error classifier (404 / exhausted retries -> FAILED)      │
│  - Chunk request timeout (25s AbortSignal)                             │
└───────────────────┬────────────────────────────────────────────────────┘
                    │ HTTP GET /get-asr-output?path={audioFile}
                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 Third-Party Upstream ASR Vendor                        │
│                 (asr-server.js / mock-transcripts.js)                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. API Specifications & Data Contracts

### 2.1 Ingest Transcription Job
- **Method & Path**: `POST /transcribe`
- **Request Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "audioChunkPaths": [
      "audio-file-1.wav",
      "audio-file-2.wav",
      "audio-file-3.wav"
    ],
    "userId": "dr_smith_4821"
  }
  ```
- **Response** (HTTP 201 Created):
  ```json
  {
    "jobId": "job_m5k8zq9_8f1a"
  }
  ```

### 2.2 Query Job Status & Transcript
- **Method & Path**: `GET /transcript/:jobId`
- **Response** (HTTP 200 OK):
  ```json
  {
    "jobId": "job_m5k8zq9_8f1a",
    "jobStatus": "COMPLETED",
    "completedTime": "2026-10-22T23:30:15.123Z",
    "transcriptText": "Chapter 1: The Quest\nOnce upon a time...\n\nThe dragon king, moved by their selfless wish...\n\nChapter Two: The Magic Within...",
    "chunkStatuses": {
      "audio-file-1.wav": "COMPLETED",
      "audio-file-2.wav": "COMPLETED",
      "audio-file-3.wav": "COMPLETED"
    }
  }
  ```

#### Partial Success Response (Permanent Failure):
If one or more chunks fail unrecoverably, the job completes as `PARTIAL_SUCCESS`:
```json
{
  "jobId": "job_m5k8zq9_8f1a",
  "jobStatus": "PARTIAL_SUCCESS",
  "completedTime": "2026-10-22T23:30:18.450Z",
  "transcriptText": "Chapter 1: The Quest\nOnce upon a time...\n\n[Transcript unavailable for audio-file-8.wav]\n\nChapter Two: The Magic Within...",
  "chunkStatuses": {
    "audio-file-1.wav": "COMPLETED",
    "audio-file-8.wav": "FAILED",
    "audio-file-2.wav": "COMPLETED"
  }
}
```

### 2.3 Search Historical Transcripts
- **Method & Path**: `GET /transcript/search?userId={userId}&jobStatus={status}`
- **Query Parameters**:
  - `userId` *(optional)*: Filter by submitting clinician ID.
  - `jobStatus` *(optional)*: Filter by lifecycle state (`COMPLETED`, `PARTIAL_SUCCESS`, `FAILED`, `PROCESSING`, `PENDING`).
- **Response** (HTTP 200 OK):
  ```json
  [
    {
      "jobId": "job_m5k8zq9_8f1a",
      "jobStatus": "COMPLETED",
      "completedTime": "2026-10-22T23:30:15.123Z",
      "transcriptText": "...",
      "chunkStatuses": { ... }
    }
  ]
  ```

### 2.4 Metrics & Observability
- **Method & Path**: `GET /api/metrics`
- **Response** (HTTP 200 OK):
  ```json
  {
    "service": "Ambience Backend Audio Transcription Service",
    "concurrency": {
      "maxConcurrency": 100,
      "activeCount": 14,
      "queueLength": 0,
      "peakActiveCount": 98,
      "totalAcquired": 6420,
      "totalReleased": 6406
    }
  }
  ```

---

## 3. Core Engineering Solutions

### 3.1 Strict Concurrency Cap ($\le 100$)
- **Problem**: Upstream ASR rejects any request over 100 with HTTP 429.
- **Solution**: Implemented `ConcurrencyLimiter` as an asynchronous FIFO semaphore.
  - An atomic counter `activeCount` tracks in-flight ASR calls.
  - If `activeCount < 100`, permits are granted synchronously.
  - If `activeCount == 100`, subsequent callers receive a Promise whose resolver is queued in a FIFO array.
  - Upon completion (`finally` block of `transcribeChunk`), `activeCount` is decremented and the next queued resolver is immediately invoked.
- **Distributed Topology (Redis Semaphore)**: In a multi-worker Kubernetes cluster, this in-memory semaphore transitions to a Redis Token Bucket / Semaphore (`ASR_SEMAPHORE`) via atomic Lua scripts or Redlock, ensuring global cluster adherence to the 100-request limit.

### 3.2 Sub-20s Latency via Parallel Chunk Fan-Out
- **Problem**: A typical 30-minute encounter comprises 6 chunks of 5 minutes each. With individual chunk ASR latency averaging 7.5 seconds (5–10s range), serial execution takes:
  $$T_{\text{serial}} = 6 \times 7.5\text{s} = 45\text{s} \quad (\text{violates } < 20\text{s})$$
- **Solution**: The worker pool launches all chunks for an encounter concurrently via `Promise.allSettled()`.
  $$T_{\text{parallel}} = \max(t_1, t_2, \dots, t_6) \approx 7.5\text{s} \pm 2.5\text{s} \approx 10\text{s} \quad (< 20\text{s happy path guaranteed})$$
- **Order Preservation**: Each chunk is tagged with its original `chunk_index` (0 to $N-1$). When stitching the final transcript, results are sorted strictly by `chunk_index`, guaranteeing chronological narrative integrity regardless of arrival order.

### 3.3 Fault Tolerance & 5% Transient Failure Handling
- **Transient Failures (5%)**: Upstream randomly throws HTTP 500 errors.
- **Retry Mechanism**: The client applies bounded exponential backoff with randomized uniform jitter:
  $$\text{Delay}(attempt) = \text{InitialDelay} \times 2^{attempt} + \text{UniformRandom}(0, \text{MaxJitter})$$
  - Attempt 1: $1000\text{ms} + [0\dots 500]\text{ms} \approx 1.25\text{s}$
  - Attempt 2: $2000\text{ms} + [0\dots 500]\text{ms} \approx 2.25\text{s}$
  - Attempt 3: $4000\text{ms} + [0\dots 500]\text{ms} \approx 4.25\text{s}$
- **Permanent Failure Handling**:
  - `audio-file-8.wav` has `shouldError: true` and will never succeed.
  - Chunks with HTTP 404 or exhausted retries are marked `FAILED`.
  - The job transitions to `PARTIAL_SUCCESS`.
  - Stitched transcript inserts a clear placeholder:
    `[Transcript unavailable for audio-file-8.wav]`
  - Valid segments are preserved intact.

### 3.4 Persistent State & Restart Recovery
- All jobs and chunk records are stored with full ACID guarantees (SQLite in WAL mode / PostgreSQL).
- When a worker or server restarts:
  1. `recoverUnfinishedJobs()` queries all records with `job_status IN ('PENDING', 'PROCESSING')`.
  2. Completed chunks (`chunk_status = 'COMPLETED'`) are preserved and never re-transcribed.
  3. Incomplete chunks are re-enqueued to the worker pool and processed under the concurrency limiter.

---

## 4. Napkin Math & System Sizing

### 4.1 Workload & Capacity Equations
- **Initial Baseline (1,000 DAU)**:
  - 1,000 users $\times$ 10 encounters/shift = 10,000 visits/day.
  - Average encounter: 30 minutes = 6 audio chunks (5 mins each).
  - Total daily chunk volume: $10,000 \times 6 = 60,000 \text{ chunks/day}$.
- **Daily Storage Growth**:
  - Average transcript text: 25 KB per encounter.
  - Daily text volume: $10,000 \times 25\text{ KB} = 250\text{ MB/day} \approx 91.25\text{ GB/year}$.
- **ASR Vendor Throughput Limit**:
  $$\text{Throughput} = \frac{100 \text{ concurrent connections}}{7.5\text{s average latency}} = 13.33 \text{ chunks/sec} = 800 \text{ chunks/min} = 48,000 \text{ chunks/hour}$$
- **Maximum DAU under 100 Concurrency Ceiling**:
  - Over an 8-hour shift ($28,800\text{ seconds}$), max raw capacity is:
    $$13.33 \text{ chunks/s} \times 28,800\text{s} = 384,000 \text{ chunks/day} = 64,000 \text{ encounters/day}$$
  - Applying a peak-hour clustering factor of $2.0\times$ yields a ceiling of:
    $$\text{Max DAU} \approx \frac{64,000}{10 \times 2.0} = 3,200 \text{ DAU before queue backpressure builds.}$$

---

## 5. 10x to 100x Scalability Strategy

| System Component | Baseline (1,000 DAU) | 10x Scale (10,000 DAU) | 100x Scale (100,000 DAU) |
|---|---|---|---|
| **ASR Concurrency** | 100 limit (Vendor default) | 300–500 limit (Negotiated Tier) + Priority Queue | 2,000+ limit across multi-region ASR endpoints |
| **Compute / Worker Pool** | Unified / Static Workers | Kubernetes Pods with HPA on queue depth | Sharded Kubernetes clusters by tenant / healthcare system |
| **Database Layer** | SQLite WAL / Single Postgres | Primary Postgres + PgBouncer + Read Replicas | Citus horizontal table sharding + Monthly chunk partitioning |
| **Task Queue / Coordination** | Relational Row Locking / In-Memory Semaphore | Redis Cluster with distributed leasing token bucket | Apache Kafka / AWS SQS with dead-letter queues |
| **Cold Storage & Archival** | Local Database | S3 / GCS object storage for raw audio and transcripts | Parquet lakehouse for clinical ML analytics |

---

## 6. How to Run, Test, and Verify

### Running the Services

1. **Unified Service (Recommended)**:
   ```bash
   npm start
   # Or for development:
   npm run dev
   ```
   Starts the API Gateway, Worker Pool, and Upstream ASR Mock together on `http://localhost:3000`.

2. **Decoupled Mode (Multi-Process)**:
   ```bash
   # Terminal 1: Start API Gateway
   npm run start:api

   # Terminal 2: Start Background Worker Daemon
   npm run start:worker
   ```

### Executing the Automated Test Suite

```bash
npm test
```
The test suite executes with clean, unformatted plain-text output (`PASSED` / `FAILED` with zero ANSI escape sequences):
- **Test 1**: Happy path latency ($< 20\text{s}$ parallel fan-out).
- **Test 2**: Fault tolerance, 3x exponential backoff, and `PARTIAL_SUCCESS` degradation.
- **Test 3**: Concurrency enforcement under stress (120 chunks never exceed 100).
- **Test 4**: Search API filtering by `userId` and `jobStatus`.
- **Test 5**: Crash durability and state recovery on reboot.

### Running the Live Interview Walkthrough Demo

```bash
npm run demo
```
Runs an automated, end-to-end 60-second walkthrough designed for the technical evaluation meeting:
1. Validates connectivity to the service.
2. Ingests a 3-chunk clinical encounter and verifies sub-20s parallel fan-out completion.
3. Ingests an encounter with `audio-file-8.wav` demonstrating 3x exponential backoff and `PARTIAL_SUCCESS` degradation.
4. Queries historical records via `GET /transcript/search`.
5. Retrieves real-time concurrency metrics via `GET /api/metrics`.

---

## 7. Operational Standards: Logging & Graceful Shutdown

- **Structured Pino JSON Logging**: All services (`API Gateway`, `WorkerPool`, `WorkerDaemon`) emit structured JSON logs (`{"level": 30, "time": "...", "component": "WorkerPool", "jobId": "...", "msg": "..."}`). This allows log ingestion engines (e.g., Datadog, CloudWatch, GCP Cloud Logging) to index search fields natively without regex parsing.
- **Clean Signal Handling (`SIGINT` / `SIGTERM`)**: Process termination signals gracefully trigger:
  1. Halting the worker queue polling loop.
  2. Awaiting in-flight chunk completions (up to a 5-second graceful drain timeout).
  3. Safely closing SQLite WAL connections and Fastify server sockets.

