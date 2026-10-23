# Technical Design Specification: Backend Audio Transcription Service

**Author**: Ambience Healthcare Engineering  
**Target Runtime**: Node.js 22 LTS  
**Architecture Type**: Asynchronous High-Throughput Microservice with Decoupled Worker Pool  

---

## 1. Executive Summary & Architecture Overview

This service implements an enterprise-grade, asynchronous backend system designed to ingest, transcribe, and stitch multi-chunk audio recordings of clinical patient-provider encounters (typically 30–120 minutes in duration, partitioned into chunks ≤ 5 minutes).

The architecture is built around four non-negotiable operational requirements:
1. **Strict Concurrency Cap (≤ 100)**: The third-party ASR vendor enforces a hard rate limit of 100 simultaneous requests. Breaching this limit triggers HTTP 429 errors and risks vendor bans.
2. **Sub-20s Happy-Path Latency**: Ingested 30-minute encounters (6 chunks × 5 min) must transcribe and stitch into a single coherent transcript in under 20 seconds.
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

### 3.1 Strict Concurrency Cap (≤ 100)
- **Problem**: Upstream ASR rejects any request over 100 with HTTP 429.
- **Solution**: Implemented `ConcurrencyLimiter` as an asynchronous FIFO semaphore.
  - An atomic counter `activeCount` tracks in-flight ASR calls.
  - If `activeCount < 100`, permits are granted synchronously.
  - If `activeCount == 100`, subsequent callers receive a Promise whose resolver is queued in a FIFO array.
  - Upon completion (`finally` block of `transcribeChunk`), `activeCount` is decremented and the next queued resolver is immediately invoked.
- **Distributed Topology (Redis Semaphore)**: In a multi-worker Kubernetes cluster, this in-memory semaphore transitions to a Redis Token Bucket / Semaphore (`ASR_SEMAPHORE`) via atomic Lua scripts or Redlock, ensuring global cluster adherence to the 100-request limit.

### 3.2 Sub-20s Latency via Parallel Chunk Fan-Out
- **Problem**: A typical 30-minute encounter comprises 6 chunks of 5 minutes each. With individual chunk ASR latency averaging 7.5 seconds (5–10s range), serial execution takes:
  `T_serial = 6 chunks × 7.5s = 45s` (violates the < 20s requirement)
- **Solution**: The worker pool launches all chunks for an encounter concurrently via `Promise.allSettled()`:
  `T_parallel = max(t_1, t_2, ..., t_6) ≈ 7.5s ± 2.5s ≈ 10s` (well under the 20s happy-path budget)
- **Order Preservation**: Each chunk is tagged with its original `chunk_index` (0 to N - 1). When stitching the final transcript, results are sorted strictly by `chunk_index`, guaranteeing chronological narrative integrity regardless of arrival order.

### 3.3 Fault Tolerance & 5% Transient Failure Handling
- **Transient Failures (5%)**: Upstream randomly throws HTTP 500 errors.
- **Retry Mechanism**: The client applies bounded exponential backoff with randomized uniform jitter:
  `Delay(attempt) = InitialDelay × (2 ^ attempt) + UniformRandom(0, MaxJitter)`
  - Attempt 1: 1000ms + [0...500]ms ≈ 1.25s
  - Attempt 2: 2000ms + [0...500]ms ≈ 2.25s
  - Attempt 3: 4000ms + [0...500]ms ≈ 4.25s
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

### 3.5 Domain Layer Separation: State Machine (`JobService`) vs. Execution (`WorkerPool`)
Following Clean Architecture and Domain-Driven Design (DDD):
- **`JobService` (Domain & State Authority)**:
  - Exclusively owns all database mutations and state transitions.
  - Manages job lifecycle rules: `markJobProcessing`, `claimChunk`, `recordChunkSuccess`, `recordChunkFailure`, `finalizeJob`, and `getTranscriptResult`.
  - Encapsulates `JobRepository`, hiding database schema details from the rest of the application.
- **`WorkerPool` (Pure Execution Orchestrator)**:
  - Holds zero direct database repository references.
  - Focuses strictly on concurrency management (token leasing under the ≤ 100 cap) and parallel HTTP chunk fan-out.
  - Informs `JobService` of chunk progress via high-level domain events.

---

## 4. Napkin Math & System Sizing

### 4.1 Workload & Capacity Equations

- **Initial Baseline (1,000 DAU)**:
  - 1,000 clinicians × 10 encounters/shift = **10,000 visits/day**.
  - Average encounter: 30 minutes = 6 audio chunks (5 mins each).
  - Total daily chunk volume: `10,000 encounters × 6 chunks = 60,000 chunks/day`.

- **Daily Storage Growth**:
  - **First-Principles Derivation**:
    - Average clinical encounter duration: **30 minutes**.
    - Speaking rate: **~140 words per minute**.
    - Total words per encounter: `30 minutes × 140 words/min = 4,200 words`.
    - Average English word length: 5 characters + 1 space/punctuation = **6 characters/word**.
    - UTF-8 text encoding: 1 byte per ASCII character.
    - Raw transcript size: `4,200 words × 6 bytes/word = 25,200 bytes ≈ 25 KB`.
  - **Daily Text Ingestion**: `10,000 encounters × 25 KB = 250 MB/day` (≈ **91.25 GB/year**).

- **ASR Vendor Throughput Limit**:
  - Theoretical maximum throughput under the hard 100-connection limit:
    `Throughput = 100 concurrent slots / 7.5s average latency = 13.33 chunks/sec`
    `= 800 chunks/min = 48,000 chunks/hour`

- **Maximum DAU under 100 Concurrency Ceiling**:
  - Over an 8-hour shift (28,800 seconds), maximum raw processing capacity is:
    `13.33 chunks/sec × 28,800 sec = 384,000 chunks/day = 64,000 encounters/day`
  - Applying a peak-hour clustering factor of 2.0× (where peak hours see 2× the average arrival rate):
    `Max DAU ≈ 64,000 encounters / (10 encounters/clinician × 2.0 peak factor) = 3,200 DAU`
  - **Key Takeaway**: Up to **3,200 clinicians** can be actively supported under the default 100-connection limit before queue backpressure builds. Beyond this volume, negotiating an expanded concurrency tier (300–500) with the vendor is required.

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
- **Test 1**: Happy path latency (< 20s parallel fan-out).
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

---

## 8. Extensibility & Future Search Architecture (V2 Roadmap)

Supporting queries "across all time" introduces architectural trade-offs between rapid MVP delivery and enterprise scalability. While the MVP filters strictly on `userId` and `jobStatus`, production EHR environments require expanded query dimensions, bounded result sets, and keyset pagination.

### 8.1 Expanded Clinical Search Dimensions

| Dimension | Filter Parameter | Functional / Clinical Value | Technical Implementation Plan | Complexity / Effort |
|---|---|---|---|---|
| **Temporal Range** | `createdAfter`, `createdBefore` | Enables shift handoffs, billing cycle audits (e.g., past 30 days), and compliance lookups without scanning all history. | Add `WHERE created_at BETWEEN ? AND ?` clause; create composite B-Tree index on `(user_id, created_at DESC)` to keep index scans fast. | **Low** (1–2 days) |
| **Patient Identification** | `patientId`, `mrn` (Medical Record Number) | Directly cross-references longitudinal patient records across hospital EHR systems (Epic, Cerner, AthenaHealth). | Add indexed `patient_id` column to `jobs` table schema; expose query parameter in API; validate against HIPAA identifier patterns. | **Low** (2–3 days) |
| **Encounter Context** | `department`, `specialty` | Supports specialty-specific workflows, departmental performance audits, and provider team filtering (e.g., Cardiology vs. Emergency Medicine). | Add normalized `department_id` or `specialty` enum/foreign key in `jobs` table; create secondary index on `(department_id, created_at DESC)`. | **Medium** (~1 week) |
| **Full-Text Clinical Search** | `query` / keywords | Powers keyword retrieval of diagnoses, symptoms, and medications (e.g., "hypertension", "penicillin allergy") across narrative transcripts. | **Single-Node/MVP**: SQLite FTS5 virtual table with trigger-based sync on chunk completion.<br>**Distributed/V2**: Stream completed encounters to an Elasticsearch/OpenSearch cluster with medical stemmers and BM25 relevance scoring. | **High** (2–3 weeks) |

### 8.2 Why Pagination is Critical & Key Bottlenecks

Returning unbounded search results across all time without pagination leads to severe system bottlenecks:

1. **API Response Size & Serialization Lag (Primary Bottleneck)**:
   - Each completed encounter transcript is ≈ **25 KB** of raw text.
   - If an active clinician searches their history over 6 months (e.g., 500 encounters), an unpaginated response produces:
     `500 encounters × 25 KB = 12.5 MB JSON payload`
   - In Node.js, serializing a 12.5 MB JSON string runs synchronously on the main Event Loop, blocking all incoming HTTP requests and causing latency spikes across the entire API Gateway.
2. **Memory Footprint & Heap Garbage Collection**:
   - Materializing thousands of database rows and stitching strings in memory creates severe heap allocations. Concurrent searches by multiple physicians could trigger Node.js V8 garbage collection pauses or Out-Of-Memory (`ERR_WORKER_OUT_OF_MEMORY`) process terminations.
3. **Network Transfer & Client UI Freezing**:
   - Transferring 10–25 MB over mobile or hospital Wi-Fi introduces multi-second network stalls. Web browsers and EHR frontends freeze while parsing megabytes of JSON text.

### 8.3 Pagination Strategy: MVP vs. V2

#### MVP Approach (Current Recommendation):
- Enforce a **Default Limit** of `50` results, with a **Hard Maximum** of `100` (`limit = Math.min(requestedLimit || 50, 100)`).
- At 50 results per page, maximum payload size is capped at ≈ **1.25 MB**, keeping response latency under 50ms and memory pressure negligible.
- Supports simple `page` / `offset` indexing for small datasets.

#### V2 Production Approach: Keyset / Cursor-Based Pagination
For hundreds of thousands of historical records, offset pagination (`OFFSET 50000`) degrades to O(N) because the database engine must scan and discard 50,000 index rows before returning the page.

V2 implements **Keyset Cursor Pagination** using a composite index:
- **Composite Index**: `CREATE INDEX idx_jobs_user_created ON jobs(user_id, created_at DESC, job_id DESC);`
- **Cursor Construction**: An opaque base64 cursor token encoding the last item's timestamp and ID:
  `cursor = base64("2026-10-22T14:30:00.000Z#job_mvk8zq9_8f1a")`
- **SQL Execution**:
  ```sql
  SELECT * FROM jobs
  WHERE user_id = :userId
    AND (created_at, job_id) < (:lastCreatedAt, :lastJobId)
  ORDER BY created_at DESC, job_id DESC
  LIMIT 50;
  ```
- **Performance**: Executes in **O(1) constant time** regardless of whether the user is on page 1 or page 5,000, eliminating database query degradation across all time.

### 8.4 Response Payload Optimization: Summary vs. Detail Views

In production, the Search API should not return the full 25 KB transcript text for every item in a list view. Instead, it should adopt a two-tier pattern:
- **`GET /transcript/search` (List View)**: Returns lightweight metadata + a brief 150-character preview excerpt (`jobId`, `userId`, `jobStatus`, `chunkCount`, `durationSeconds`, `snippet`).
  - Reduces per-encounter payload size from 25 KB down to **~300 bytes** (an **80x reduction**). A 50-item page drops from 1.25 MB to just **15 KB**!
- **`GET /transcript/:jobId` (Detail View)**: Full transcript text is only fetched when the user clicks on a specific encounter record.


