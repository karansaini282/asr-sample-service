# Technical Presentation Slide Deck: Ambience Audio Transcription Service

> **Format Guide**: This slide deck is structured for a **45–60 minute technical walk-through interview**. 
> Each slide includes:
> 1. **Visual Layout & Diagram** (recommended visual structure for Google Slides).
> 2. **On-Slide Content** (concise, high-impact text to put directly on the slide).
> 3. **Word-for-Word Speaker Script** (natural, confident engineering narrative).
> 4. **Anticipated Interviewer Questions & Answers** (deep-dive technical follow-ups).

---

## Recommended Google Slides Visual Theme
- **Theme Style**: Clean Minimalist Engineering
- **Palette**:
  - Background: Crisp White (`#FFFFFF`) or Dark Canvas (`#0F172A`)
  - Primary Headers: Deep Slate / Navy (`#1E293B`)
  - Accent / Highlights: Ambience Medical Teal (`#0EA5E9` / `#0D9488`)
  - Status Indicators: Emerald Green (`#10B981`), Amber Warning (`#F59E0B`), Coral Danger (`#EF4444`)

---

# Slide 1: Title & Executive Overview

### Slide Header
**High-Throughput Asynchronous Audio Transcription Service**  
*Architectural Deep-Dive & System Design for Ambient Clinical Intelligence*

### Visual Layout
```
┌────────────────────────────────────────────────────────────────────────┐
│ [EMR / Mobile Client] ──► [Chunker (≤ 5 min)] ──► [Our Backend Service]│
│                                                          │             │
│                                                          ▼             │
│   • Sub-20s Parallel Turnaround         [Strict 100 ASR Concurrency]   │
│   • Graceful Partial Degradation        [ACID Durability & Recovery]   │
└────────────────────────────────────────────────────────────────────────┘
```

### On-Slide Content
- **Problem Space**: Ingesting, transcribing, and stitching multi-chunk audio from 30–120 minute clinical encounters.
- **The Core Mission**: Deliver rapid, coherent narrative transcripts to downstream clinical scribes without violating vendor rate limits or dropping patient history.
- **Key Architectural Highlights**:
  - **Sub-20s Latency Guarantee**: Parallel fan-out processing across all encounter audio chunks.
  - **Strict Rate Enforcement**: Async FIFO semaphore maintaining upstream ASR concurrency $\le 100$.
  - **Resilient Fault Tolerance**: 3x exponential backoff with randomized jitter and `PARTIAL_SUCCESS` state degradation.
  - **Clean Domain Boundaries**: Strict decoupling between domain lifecycle authority (`JobService`) and execution orchestration (`WorkerPool`).

### Speaker Script (3–4 minutes)
> "Good morning / afternoon everyone. Today I'm excited to walk you through the architectural design and production implementation of our Backend Audio Transcription Service for Ambience Healthcare.
> 
> In ambient clinical intelligence, our core value proposition is freeing clinicians from the burden of medical documentation so they can focus entirely on patient care. Clinicians record visits that typically range from 30 minutes to two hours. By the time the doctor finishes a visit and walks to their desk, they expect a coherent, beautifully structured draft note ready for their review.
> 
> However, building the transcription pipeline behind this experience presents four distinct engineering challenges:
> First, our upstream ASR vendor enforces a hard rate limit of 100 concurrent connections—exceeding it triggers HTTP 429s and risks immediate service termination.
> Second, long clinical encounters partitioned into 5-minute chunks would take 45 seconds or longer if processed serially, completely blowing past our sub-20 second SLA.
> Third, real-world network and speech services are inherently flaky: 5% of upstream requests fail transiently, and corrupted audio chunks can fail permanently. We must gracefully degrade without discarding valid clinical data.
> And fourth, our persistence layer must guarantee that not a single word of clinical audio is lost across container crashes or host restarts.
> 
> Over the next 45 minutes, I'll walk you through how our system architecture addresses each of these constraints, the math behind our sizing, and how this design scales 10x to 100x."

### Anticipated Interviewer Q&A
- **Q: Why chunk audio into 5-minute pieces rather than streaming the whole 30 minutes in a single socket?**  
  *A: Chunking enables parallel horizontal fan-out, allows fine-grained retries on individual flaky segments rather than re-transcribing a 30-minute recording from scratch, and reduces peak memory consumption on both our workers and the ASR engine.*

---

# Slide 2: Core Operational Constraints & SLA Matrix

### Slide Header
**Operational Constraints: The Rules of Engagement**

### Visual Layout
```
┌──────────────────────────┬─────────────────────────┬──────────────────────────┐
│ Requirement              │ Engineering Constraint  │ Consequence of Failure   │
├──────────────────────────┼─────────────────────────┼──────────────────────────┤
│ Upstream Concurrency     │ Hard Cap ≤ 100 requests │ HTTP 429 & Vendor Bans   │
│ Turnaround Latency       │ < 20s for 30-min visit  │ Physician Workflow Stalls│
│ Flakiness & Corruption   │ 5% HTTP 500s + Bad WAVs │ Corrupted Medical Record │
│ System Crashes           │ In-flight task restarts │ Lost Clinical Audio      │
└──────────────────────────┴─────────────────────────┴──────────────────────────┘
```

### On-Slide Content
- **1. Upstream Concurrency Cap ($\le 100$)**:
  - Vendor imposes hard ceiling on active in-flight HTTP connections.
  - No client-side bursting allowed; rate limiter must act as a synchronous/async barrier.
- **2. Sub-20s Happy-Path Latency**:
  - Ingested 30-minute encounters (6 chunks $\times$ 5 min) must transcribe and stitch in $< 20\text{s}$.
  - Serial execution ($6 \times 7.5\text{s} = 45\text{s}$) is non-viable.
- **3. Fault Tolerance & Graceful Degradation**:
  - 5% random upstream 500 errors require automated retry with randomized jitter.
  - Permanent failures (e.g., `audio-file-8.wav`) must degrade into `PARTIAL_SUCCESS` with missing-audio markers.
- **4. Authoritative Crash Durability**:
  - System restarts must resume unfinished jobs without re-transcribing completed chunks.

### Speaker Script (4 minutes)
> "Before writing any code, we defined the strict boundaries our system must live within.
> 
> Our first constraint is the hard rate limit of 100 concurrent requests imposed by the ASR vendor. In a multi-tenant cloud environment where hundreds of doctors finish visits at the same hour, naive asynchronous dispatching would immediately flood the vendor with 200 or 300 requests, triggering HTTP 429s and taking down transcription across our entire hospital network.
> 
> Second, let's look at the latency math. A 30-minute encounter broken into 5-minute chunks produces 6 separate audio files. With upstream ASR latency averaging 7.5 seconds per chunk, sequential processing takes 45 seconds. That violates the 20-second threshold. Parallel processing isn't an optimization here—it is a mandatory architectural requirement.
> 
> Third, medical data cannot simply throw an unhandled 500 exception and abandon the user. When a chunk encounters transient flakiness, we must retry with exponential backoff and randomized jitter to prevent the 'thundering herd' problem. And when an audio chunk is genuinely corrupt or unrecoverable, we must preserve every valid piece of the transcript, flag the record as `PARTIAL_SUCCESS`, and insert a clear missing-segment marker so the clinician knows exactly where audio was lost.
> 
> Finally, our state machine must be crash-resilient. If a worker pod is evicted by Kubernetes midway through a 6-chunk encounter, our database must remember the 4 chunks that already completed and only re-process the remaining 2 chunks upon restart."

### Anticipated Interviewer Q&A
- **Q: What happens if the vendor latency temporarily spikes from 7.5s to 15s?**  
  *A: Because our concurrency limiter caps active in-flight requests at 100, a latency spike reduces overall chunk throughput from 13.3 to 6.6 chunks/sec. Instead of crashing upstream, excess requests cleanly accumulate in our FIFO queue, and our API exposes this backpressure via `queueLength` in `/api/metrics`.*

---

# Slide 3: High-Level System Architecture

### Slide Header
**End-to-End System Architecture**

### Visual Layout
```
┌────────────────────────────────────────────────────────────────────────┐
│                        Fastify API Gateway                             │
│       [POST /transcribe]  [GET /transcript/:id]  [GET /api/metrics]     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Invokes Domain Methods
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                              JobService                                │
│       [The Authoritative Domain & Business Logic Orchestrator]         │
│  • Manages State Transitions   • Stitches Transcripts   • ACID Updates │
└───────────────────┬────────────────────────────────▲───────────────────┘
                    │ Reads & Writes                 │ Reports Outcomes
                    ▼                                │
┌──────────────────────────────────────┐  ┌──────────┴───────────────────┐
│        Authoritative Data Store      │  │          WorkerPool          │
│       (SQLite WAL / PostgreSQL)      │  │  [Pure Execution Coordinator]│
│  • jobs & job_chunks tables          │  │  • Parallel Chunk Fan-Out    │
│  • Multi-reader / single-writer      │  │  • Zero Database Knowledge   │
└──────────────────────────────────────┘  └──────────────┬───────────────┘
                                                         │ Requests Permit
                                                         ▼
                                          ┌──────────────────────────────┐
                                          │      ConcurrencyLimiter      │
                                          │  • Active In-Flight ≤ 100    │
                                          │  • FIFO Queue for Excess     │
                                          └──────────────┬───────────────┘
                                                         │ Permit Granted
                                                         ▼
                                          ┌──────────────────────────────┐
                                          │          AsrClient           │
                                          │  • 3x Jittered Backoff       │
                                          │  • HTTP GET /get-asr-output  │
                                          └──────────────────────────────┘
```

### On-Slide Content
- **Fastify API Gateway**: Ultra-low overhead HTTP router handling payload validation and status queries.
- **JobService (Domain Core)**: Single source of truth for job lifecycle states, chunk status transitions, and transcript narrative stitching.
- **WorkerPool (Execution Core)**: Stateless orchestrator fanning out concurrent chunk requests without direct database entanglement.
- **ConcurrencyLimiter**: Asynchronous semaphore preventing active ASR requests from ever exceeding 100.
- **AsrClient**: Resilient HTTP client with retry policies, timeout guards, and error classification.
- **Authoritative Data Store**: ACID-compliant relational storage with Write-Ahead Logging (WAL) for instant non-blocking reads.

### Speaker Script (5 minutes)
> "Here you can see the complete end-to-end architecture of the transcription service.
> 
> When an audio ingestion payload arrives at the Fastify API Gateway via `POST /transcribe`, the gateway validates the user ID and audio paths, then delegates directly to `JobService`. `JobService` generates a unique job ID, inserts the parent job and child chunks into the database with initial status `PENDING`, and immediately returns HTTP 201 Created with the job ID. This entire ingestion handshake completes in under 10 milliseconds.
> 
> Behind the scenes, `WorkerPool` is notified to process the job. Notice the deliberate separation between `WorkerPool` and our persistence layer: `WorkerPool` has zero direct database knowledge. It does not run SQL queries or know about database columns. Instead, it asks `JobService` for incomplete chunks, coordinates their execution, and reports chunk outcomes back via clean domain events.
> 
> To execute each chunk, `WorkerPool` calls `AsrClient`. Before `AsrClient` opens an HTTP connection to the upstream vendor, it must pass through the `ConcurrencyLimiter`. If there are 99 requests currently active, the request proceeds immediately. If all 100 slots are occupied, the limiter suspends the caller in an asynchronous FIFO queue. 
> 
> Once the HTTP response returns, the limiter releases the permit to the next queued request in its `finally` block, and the outcome flows back up to `JobService`. Once all chunks settle, `JobService` finalizes the job status to `COMPLETED` or `PARTIAL_SUCCESS` and records the exact completion timestamp."

### Anticipated Interviewer Q&A
- **Q: Why Fastify over Express?**  
  *A: Fastify delivers 2x–3x the throughput of Express due to its internal schema compilation (using `fast-json-stringify`) and lightweight middleware pipeline. In a high-volume service handling thousands of polling requests, Fastify keeps CPU overhead negligible.*

---

# Slide 4: Sub-20s Latency via Parallel Chunk Fan-Out

### Slide Header
**Latency Engineering: Beating the 20-Second SLA**

### Visual Layout
```
SERIAL EXECUTION (Violates SLA: 45s Total):
[ Chunk 1: 7.5s ] ──► [ Chunk 2: 7.5s ] ──► [ Chunk 3: 7.5s ] ──► [ Chunk 4: 7.5s ] ──► [ Chunk 5: 7.5s ] ──► [ Chunk 6: 7.5s ]
0s                                                                                                                  45s

PARALLEL FAN-OUT (Meets SLA: ~10s Total):
┌── [ Chunk 1: 7.5s ] ──────────────────────┐
├── [ Chunk 2: 8.2s ] ─────────────────────────┐
├── [ Chunk 3: 6.8s ] ────────────────────┐    │
├── [ Chunk 4: 9.1s ] ───────────────────────────┐
├── [ Chunk 5: 7.3s ] ──────────────────────┤    │
└── [ Chunk 6: 8.5s ] ─────────────────────────┤ │
                                            ▼ ▼ ▼
                                   [Stitch via chunk_index] ──► COMPLETED in 9.1s!
0s                                          10s
```

### On-Slide Content
- **The Mathematical Reality**:
  - $N = 6$ chunks per 30-minute encounter (average 5 min each).
  - Upstream latency: $5.0\text{s} \le t_{\text{chunk}} \le 10.0\text{s}$ (mean = $7.5\text{s}$).
  - Serial latency: $T_{\text{serial}} = \sum_{i=1}^{6} t_i \approx 45\text{s}$ (**violates SLA by 125%**).
  - Parallel latency: $T_{\text{parallel}} = \max(t_1, \dots, t_6) \approx 7.5\text{s} \pm 2.5\text{s} \approx 10\text{s}$ (**comfortably under 20s budget**).
- **Execution Primitive**: `Promise.allSettled()` ensures that slower or failed chunks never abort healthy in-flight chunks.
- **Narrative Integrity**: Chunks are indexed (`chunk_index: 0...N-1`). The final transcript stitches chunks strictly by index, guaranteeing chronological consistency regardless of completion order.

### Speaker Script (4 minutes)
> "Let's examine how we guarantee the sub-20 second happy-path latency.
> 
> As you can see in the top timeline, if we processed a 30-minute encounter sequentially, we would simply add up the individual chunk latencies. At 7.5 seconds per chunk across 6 chunks, serial execution takes 45 seconds. That is unacceptable for a clinician waiting for their note.
> 
> In our architecture, the moment `processJob()` is invoked, we execute a concurrent fan-out. We map every incomplete chunk into an independent async promise and await them simultaneously using `Promise.allSettled()`.
> 
> Because they run in parallel, the total elapsed turnaround time is not the sum of chunk latencies—it is bounded by the slowest single chunk: $\max(t_1 \dots t_6)$. In our test runs, a 3-chunk encounter finishes in ~7.3 seconds, and a 6-chunk encounter completes in ~9.5 seconds. Even with an occasional transient retry on one chunk, the entire encounter easily completes in 14 to 16 seconds—well within our 20-second threshold.
> 
> An essential detail here is narrative order. Because network responses arrive out of order—chunk 3 might return before chunk 1—each chunk record stores its immutable `chunk_index`. When `JobService` stitches the final narrative, it sorts strictly by this index, guaranteeing that the patient's history and physical examination are assembled in the exact chronological order spoken."

### Anticipated Interviewer Q&A
- **Q: What if an encounter has 25 chunks (a 2-hour visit)? Does fan-out still work?**  
  *A: Yes! If 25 chunks are dispatched, all 25 acquire concurrency permits. If slots are available, they all process simultaneously in ~10s. If cluster-wide concurrency is near 100, the limiter queues excess chunks in FIFO order, naturally leveling the load without crashing.*

---

# Slide 5: Strict Concurrency Enforcement & Limiter Design

### Slide Header
**Guarding the Upstream ASR: The Strict Concurrency Limiter**

### Visual Layout
```
                          INCOMING CHUNKS FROM WORKERS
                                       │
                                       ▼
                         ┌───────────────────────────┐
                         │   ConcurrencyLimiter      │
                         │   activeCount < 100 ?     │
                         └───────┬───────────┬───────┘
                                 │ YES       │ NO
                     ┌───────────┘           └───────────┐
                     ▼                                   ▼
        ┌─────────────────────────┐         ┌─────────────────────────┐
        │  Increment activeCount  │         │  Push Resolver Promise  │
        │  Execute ASR Fetch      │         │  to FIFO Wait Queue     │
        └────────────┬────────────┘         └────────────┬────────────┘
                     │                                   ▲
                     ▼ (Request Completes)               │
        ┌─────────────────────────┐                      │
        │  finally {              │                      │
        │    activeCount--;       │                      │
        │    shift() & resolve() ─┼──────────────────────┘
        │  }                      │
        └─────────────────────────┘
```

### On-Slide Content
- **The Core Problem**: Upstream ASR vendor enforces a hard cap of 100 simultaneous requests. HTTP 429 penalties are severe.
- **The Mechanism**: Custom `ConcurrencyLimiter` implementing an asynchronous FIFO semaphore.
  - `activeCount`: Atomic counter tracking requests currently inside the vendor network stack.
  - `queue`: Array of promise resolvers waiting for available capacity.
  - Zero polling overhead: When a slot opens, the next queued request is resolved synchronously in $O(1)$ time.
- **Observability**: Live metrics endpoint (`GET /api/metrics`) exposes:
  - `activeCount`, `queueLength`, `peakActiveCount`, `totalAcquired`, `totalReleased`.
- **Horizontal Scalability Path**: Seamless transition from single-node in-memory semaphore to a distributed **Redis Token Bucket** using atomic Lua scripts.

### Speaker Script (4 minutes)
> "Now let's dive into how we protect the upstream ASR vendor.
> 
> Many teams make the mistake of using leaky bucket delays or client-side sleep timers to throttle traffic. But timers don't protect you when network requests take variable amounts of time. If you fire 10 requests per second and each takes 15 seconds, you will quickly have 150 concurrent sockets open.
> 
> To guarantee that we never exceed 100 active connections, we built `ConcurrencyLimiter` as an asynchronous FIFO semaphore.
> 
> When `AsrClient` prepares to make an HTTP call, it calls `limiter.run(task)`. If `activeCount` is under 100, the counter increments and the HTTP fetch executes immediately. But if all 100 slots are occupied, the limiter creates a pending Promise, pushes its resolver into a FIFO queue, and halts execution right there without blocking the Node.js event loop.
> 
> Crucially, wrapped inside a `finally` block, whenever an HTTP request finishes—whether it succeeded, failed, or timed out—`activeCount` decrements, and the limiter immediately pops the next resolver from the queue and activates it.
> 
> In Test 3 of our automated test suite, we bombard the service with 120 simultaneous chunk requests across 20 encounters. Our test monitors active concurrency every 15 milliseconds. The peak active count reaches exactly 100, stays locked at 100, and never registers 101. Upstream never sees a single 429 error."

### Anticipated Interviewer Q&A
- **Q: How does this work when you scale to 10 worker pods in Kubernetes?**  
  *A: In-memory semaphores only work within a single process. In multi-pod production, we replace the in-memory array with a distributed Redis semaphore. We use an atomic Lua script (`EVAL`) that checks `SCARD active_connections < 100`, adds the job with an expiring TTL, and removes it on completion. This maintains a single global concurrency ceiling across the entire Kubernetes fleet.*

---

# Slide 6: Fault Tolerance & Graceful Degradation

### Slide Header
**Resilience Engineering: Handling Flakiness & Bad Data**

### Visual Layout
```
TRANSIENT FAILURE (HTTP 500) ──► JITTERED EXPONENTIAL BACKOFF:
  Attempt 1: 1000ms + [0...500ms] jitter  (≈ 1.25s) ──► HTTP 500
  Attempt 2: 2000ms + [0...500ms] jitter  (≈ 2.25s) ──► HTTP 500
  Attempt 3: 4000ms + [0...500ms] jitter  (≈ 4.25s) ──► HTTP 200 (Recovered!)

PERMANENT FAILURE (HTTP 404 / audio-file-8.wav) ──► PARTIAL SUCCESS:
┌────────────────────────────────────────────────────────────────────────┐
│ Chunk 1 (audio-file-7.wav): COMPLETED  ──► "Chapter Four: The Dance..."│
│ Chunk 2 (audio-file-8.wav): FAILED     ──► [Transcript unavailable]    │
│ Chunk 3 (audio-file-9.wav): COMPLETED  ──► "The Elemental Spirits..." │
├────────────────────────────────────────────────────────────────────────┤
│ Job Status: PARTIAL_SUCCESS | Completed: 2026-10-30T12:00:00Z          │
└────────────────────────────────────────────────────────────────────────┘
```

### On-Slide Content
- **Transient Failure Handling (5% upstream failure rate)**:
  - Bounded exponential backoff with full randomized jitter:  
    $$\text{Delay} = \text{InitialDelay} \times 2^{\text{attempt}} + \text{UniformRandom}(0, \text{MaxJitter})$$
  - Prevents synchronized retry spikes (thundering herd).
- **Permanent Failure Classification**:
  - HTTP 404 (Missing audio) $\rightarrow$ Fail immediately without burning retry budget.
  - Corrupted audio (e.g. `audio-file-8.wav`) $\rightarrow$ Max 3 retries, then mark chunk `FAILED`.
- **Graceful Degradation (`PARTIAL_SUCCESS`)**:
  - The job does not fail or crash.
  - Valid audio segments are stitched and preserved intact.
  - Missing audio placeholder inserted: `[Transcript unavailable for audio-file-8.wav]`.
  - Clinicians and downstream scribes receive clear alerts to re-dictate the missing section.

### Speaker Script (5 minutes)
> "Let's talk about resilience. Distributed systems fail, and external vendors fail even more frequently.
> 
> In our specification, 5% of all upstream ASR requests randomly fail with HTTP 500 errors. If you retry immediately, you risk compounding upstream congestion. If you retry on fixed intervals—say, exactly 1 second—every worker that failed simultaneously will retry simultaneously, creating a thundering herd.
> 
> To solve this, `AsrClient` implements bounded exponential backoff with randomized uniform jitter. On the first failure, we wait 1 second plus a random jitter between 0 and 500 milliseconds. On the second, 2 seconds plus jitter. On the third, 4 seconds plus jitter. This spreads retry traffic across the time domain, maximizing the probability of upstream recovery.
> 
> But what happens when an audio file is permanently unrecoverable? In our test fixtures, `audio-file-8.wav` has `shouldError: true` and will fail 100% of the time. Similarly, an audio file that doesn't exist returns HTTP 404.
> 
> In a naive system, one bad chunk crashes the entire encounter, throwing away the other 25 minutes of transcribed patient history. In our system:
> 1. If an error is permanent (like a 404), we fail the chunk immediately without wasting retries.
> 2. If retries are exhausted, the chunk transitions to `FAILED`.
> 3. `JobService` detects that some chunks completed while others failed, and sets the overall job status to `PARTIAL_SUCCESS`.
> 4. In the stitched transcript, we insert a standardized placeholder: `[Transcript unavailable for audio-file-8.wav]`.
> 
> The doctor still receives 95% of their patient's note, and the EHR clearly flags the exact missing window."

### Anticipated Interviewer Q&A
- **Q: Why insert a placeholder text rather than omitting the failed chunk entirely?**  
  *A: In clinical healthcare, omissions are dangerous. If a doctor spoke about a patient's medication allergy during chunk 2, omitting chunk 2 silently could lead to a harmful medical error. An explicit missing-segment placeholder alerts both the doctor and our downstream AI scribe that audio is missing from that timeframe.*

---

# Slide 7: Authoritative Persistence & Crash Durability

### Slide Header
**Durability & Crash Recovery: Zero Lost Encounters**

### Visual Layout
```
SQLite WAL Architecture:
┌─────────────────────────┐      ┌─────────────────────────┐
│   transcription.db      │◄─────┤   transcription.db-wal  │◄── Workers (Append-Only)
│   (Canonical B-Tree)    │Check-│   (Write-Ahead Log)     │
└────────────┬────────────┘point └─────────────────────────┘
             │                               ▲
             └─────── Readers (Zero Lock) ───┘

RESTART RECOVERY LIFECYCLE:
[Server Process Crashes] ──► [Server Reboots] ──► recoverUnfinishedJobs()
                                                        │
┌───────────────────────────────────────────────────────┴───────────────────────┐
│ • Queries jobs WHERE job_status IN ('PENDING', 'PROCESSING')                   │
│ • Preserves COMPLETED chunks (never re-transcribes already finished segments) │
│ • Re-enqueues only incomplete chunks through ConcurrencyLimiter               │
└───────────────────────────────────────────────────────────────────────────────┘
```

### On-Slide Content
- **Storage Engine**: Embedded SQLite with Write-Ahead Logging (`PRAGMA journal_mode = WAL;`).
- **Why WAL + `synchronous = NORMAL`**:
  - **Zero-Lock Concurrency**: Readers never block writers; writers never block readers. Clinicians reading history never pause background worker chunk updates.
  - **10x–50x Speedup**: Sequential log appends instead of blocking hardware `fsync()` on every commit.
  - **100% Crash Durability**: Even under process kills (`kill -9`) or host power loss, uncorrupted transactions recover cleanly via checksummed WAL frames.
- **Automated Crash Reconciliation**:
  - On startup, `recoverUnfinishedJobs()` identifies orphaned in-flight jobs.
  - Completed chunks remain saved; incomplete chunks are re-dispatched.

### Speaker Script (4 minutes)
> "Next, let's examine our persistence and crash recovery guarantees.
> 
> We chose SQLite using Node 22's built-in `node:sqlite` engine for local storage, configured with Write-Ahead Logging (WAL) and `PRAGMA synchronous = NORMAL`.
> 
> In traditional rollback journal mode, writing to a database locks the entire file. If a worker is writing chunk 5, an API request trying to read completed chunk 1 has to wait. In WAL mode, the main database file is never touched during writes. Changes are appended sequentially to a separate `-wal` file, while readers look up pages through an in-memory shared index (`-shm`).
> 
> This completely decouples reads from writes: 50 clinicians can poll their transcript status while 100 worker threads write chunk updates, with zero lock contention.
> 
> Furthermore, with `synchronous = NORMAL`, SQLite syncs to disk during checkpoints rather than forcing a slow hardware `fsync` on every single transaction. This delivers a 10x to 50x throughput improvement while remaining fully crash-safe.
> 
> Finally, look at our restart reconciliation flow. If our server crashes or is redeployed in the middle of a job:
> When the service boots up, `recoverUnfinishedJobs()` immediately queries for any jobs marked `PENDING` or `PROCESSING`.
> Because completed chunk records are already safely in the database, the service does not waste money or time re-transcribing chunks that already succeeded. It picks up right where it left off, dispatches only the remaining chunks through the concurrency limiter, and finalizes the job."

### Anticipated Interviewer Q&A
- **Q: When would you graduate from SQLite WAL to PostgreSQL?**  
  *A: SQLite WAL is ideal for single-instance, high-performance local processing (capable of tens of thousands of transactions/second). The moment we deploy multi-replica worker pods in Kubernetes that need to share a unified database, we transition to PostgreSQL with connection pooling (e.g., PgBouncer).*

---

# Slide 8: Domain-Driven Design & Separation of Concerns

### Slide Header
**Clean Architecture: Separating Domain Authority from Execution**

### Visual Layout
```
┌────────────────────────────────────────────────────────────────────────┐
│                        Fastify API Gateway                             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Calls Domain Methods
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                              JobService                                │
│       [The Authoritative Domain & Business Logic Orchestrator]         │
│  • createJob()           • claimChunk()          • recordChunkSuccess()│
│  • finalizeJob()         • findUnfinishedJobs()  • DynamicQueryBuilder │
└───────────────────┬────────────────────────────────▲───────────────────┘
                    │ Exclusive Owner                │ Clean Domain Events
                    ▼ of Database                    │ (No SQL Leakage)
┌──────────────────────────────────────┐  ┌──────────┴───────────────────┐
│            JobRepository             │  │          WorkerPool          │
│  • Raw SQL schemas & indexes         │  │  [Pure Execution Orchestrator│
│  • ACID transactions                 │  │  • Parallel Chunk Fan-Out    │
│  • Zero Business Logic               │  │  • Rate-Limit Permits        │
└──────────────────────────────────────┘  │  • ZERO Database Knowledge   │
                                          └──────────────────────────────┘
```

### On-Slide Content
- **Single Responsibility Principle (SRP)**:
  - `JobService`: Owns state transitions, business validation, transcript stitching, and database mutations.
  - `WorkerPool`: Owns execution orchestration, rate-limit permits, and parallel chunk fan-out.
- **Zero Database Leakage**:
  - `WorkerPool` has no reference to `JobRepository`. It has zero knowledge of SQL tables, column names, or raw queries.
- **Anti-Pattern Elimination**:
  - Replaced legacy `WHERE 1=1` hacks with a clean, reusable `DynamicQueryBuilder` supporting composable, parameterized filters (`whereIf`, `orderBy`, `limit`).
- **Testability**:
  - Domain rules can be tested in isolation with in-memory repositories.
  - Workers can be unit-tested with mock job services without spinning up database engines.

### Speaker Script (4 minutes)
> "A core focus of our codebase refactoring was establishing a strict domain boundary following Clean Architecture and Domain-Driven Design.
> 
> Earlier in development, our `WorkerPool` had direct database access, writing chunk status updates and deciding when jobs were completed. This created tight coupling: if our schema changed or if we migrated to Postgres, we would have had to modify worker code.
> 
> We refactored this into a clean two-layer model:
> `JobService` is the sole domain authority. It encapsulates `JobRepository` completely. It defines what it means to create a job, claim a chunk, record a success or failure, and finalize an encounter.
> 
> `WorkerPool` was transformed into a pure execution coordinator. It has zero references to `JobRepository`. It asks `JobService` for incomplete chunks, coordinates their execution through `AsrClient` under our rate limits, and notifies `JobService` via domain events like `recordChunkSuccess()` and `finalizeJob()`.
> 
> We also applied this discipline to our SQL queries. In many dynamic search implementations, developers use the `WHERE 1=1` string concatenation pattern. While functional, it is considered a code smell and triggers warnings in static security linters. We built a lightweight, zero-dependency `DynamicQueryBuilder` that safely handles parameterized `whereIf` conditions, ordering, and limits without artificial literals.
> 
> The result is a codebase where business rules, persistence, and network orchestration are completely isolated, making testing and maintenance effortless."

### Anticipated Interviewer Q&A
- **Q: How does this separation make unit testing easier?**  
  *A: In our automated test suite, we can instantiate `WorkerPool` passing a mock `jobService` and test concurrency edge cases in 50 milliseconds without touching disk I/O. Conversely, we can test `JobService` state transitions against an in-memory SQLite database (`:memory:`) without making real HTTP calls.*

---

# Slide 9: Napkin Math & System Sizing

### Slide Header
**Capacity Planning & Napkin Math: First-Principles Sizing**

### Visual Layout
```
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│      140 WORDS PER MINUTE       │   │        STORAGE FOOTPRINT        │
│  • 30 min visit = 4,200 words   │   │  • 25.2 KB text per encounter   │
│  • 6 chars/word (UTF-8)         │   │  • 10,000 visits/day (1,000 DAU)│
│  • 4,200 × 6 B = 25.2 KB/visit  │   │  • 250 MB/day ≈ 91.25 GB/year   │
└─────────────────────────────────┘   └─────────────────────────────────┘
                                       
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│     ASR VENDOR THROUGHPUT       │   │     MAXIMUM CLINICIAN CEILING   │
│  • 100 slots / 7.5s avg latency │   │  • 8-hr shift = 64,000 visits   │
│  • 13.33 chunks/s = 800 chunks/m│   │  • 2.0x peak hour factor        │
│  • 48,000 chunks/hour           │   │  • Bottleneck Ceiling: 3,200 DAU│
└─────────────────────────────────┘   └─────────────────────────────────┘
```

### On-Slide Content
- **1. Text Storage Derivation (140 Words/Min)**:
  - Clinical encounter: 30 minutes $\times$ 140 words/min = 4,200 words.
  - Average word length: 5 characters + 1 space = 6 bytes (UTF-8).
  - Raw narrative text: $4,200 \times 6 = \mathbf{25.2\text{ KB}}$ per encounter.
  - Daily text volume (1,000 DAU, 10 visits/day): $10,000 \times 25\text{ KB} = \mathbf{250\text{ MB/day}}$ ($\approx \mathbf{91.25\text{ GB/year}}$).
- **2. Vendor Concurrency Bottleneck**:
  - Maximum raw throughput: $\frac{100 \text{ connections}}{7.5\text{s latency}} = \mathbf{13.33\text{ chunks/sec}} = \mathbf{48,000\text{ chunks/hour}}$.
- **3. Maximum Supported Clinicians (DAU Ceiling)**:
  - In an 8-hour shift ($28,800\text{s}$), max processing capacity is 64,000 encounters.
  - Factoring in a **$2.0\times$ peak-hour clustering multiplier** (surge after morning rounds):
    $$\text{Max Capacity} = \frac{64,000 \text{ encounters}}{10 \text{ encounters/doctor} \times 2.0 \text{ peak factor}} \approx \mathbf{3,200\text{ DAU}}$$
  - **Conclusion**: Beyond 3,200 active clinicians, we must negotiate an expanded concurrency tier (300–500) with the vendor.

### Speaker Script (5 minutes)
> "Let's walk through the napkin math behind our capacity planning.
> 
> First, storage sizing. Human speech averages roughly 140 words per minute. Over a 30-minute encounter, that's 4,200 words. In English, words average 5 characters, plus 1 space or punctuation mark, giving 6 characters per word. Since ASCII characters take 1 byte in UTF-8, each completed transcript is approximately 25.2 kilobytes of text.
> 
> At our baseline scale of 1,000 daily active clinicians averaging 10 visits per day, we ingest 10,000 encounters—or 60,000 audio chunks—every single day. That generates 250 megabytes of transcript text per day, or about 91 gigabytes per year. This is remarkably lightweight: a standard PostgreSQL or SQLite volume can easily retain decades of textual medical records without special partitioning.
> 
> Now let's calculate the real bottleneck: our vendor's 100-connection ceiling.
> With average chunk latency at 7.5 seconds, our maximum possible throughput across 100 concurrent slots is: 100 divided by 7.5, which equals 13.33 chunks per second, or 48,000 chunks per hour.
> 
> Over a typical 8-hour hospital shift, our raw hardware ceiling can process 384,000 chunks, or 64,000 patient visits.
> 
> But healthcare is not uniformly distributed: doctors finish morning clinics around 11:30 AM and afternoon clinics around 4:30 PM. Applying a standard 2.0x peak-hour clustering factor, our maximum supportable user base under the default 100-connection limit is: 64,000 divided by 20, which is exactly **3,200 Daily Active Clinicians**.
> 
> This gives engineering and product a clear metric: the moment our active user base approaches 3,000 physicians, we must negotiate an upgraded tier of 300 to 500 concurrent connections with the ASR vendor."

### Anticipated Interviewer Q&A
- **Q: What about audio storage? Where do the WAV files live?**  
  *A: Audio files are stored in object storage (AWS S3 or Google Cloud Storage) with lifecycle policies: warm storage for 30 days for re-processing or auditing, transitioning to Glacier/cold storage for long-term medical-legal compliance.*

---

# Slide 10: Extensibility, Future Search & Scaling Roadmap

### Slide Header
**The Road to V2 & 100x Scale: Extensibility & Architecture Evolution**

### Visual Layout
```
EXPANDED SEARCH DIMENSIONS:
┌─────────────────────┬────────────────────────────────┬────────────────────────┐
│ Search Dimension    │ Technical Implementation Plan  │ Effort & Complexity    │
├─────────────────────┼────────────────────────────────┼────────────────────────┤
│ Temporal Range      │ WHERE created_at BETWEEN ? & ? │ LOW (1–2 days)         │
│ Patient MRN         │ Indexed patient_id in jobs     │ LOW (2–3 days)         │
│ Department / Team   │ Secondary index on specialty   │ MEDIUM (~1 week)       │
│ Full-Text Search    │ SQLite FTS5 / Elasticsearch    │ HIGH (2–3 weeks)       │
└─────────────────────┴────────────────────────────────┴────────────────────────┘

HORIZONTAL SCALING (1,000 ──► 100,000 DAU):
┌─────────────────────────────────┬─────────────────────────────────┬─────────────────────────────────┐
│ Baseline (1,000 DAU)            │ 10x Scale (10,000 DAU)          │ 100x Scale (100,000 DAU)        │
├─────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
│ • In-Memory Semaphore (100)     │ • Redis Distributed Token Bucket│ • Multi-Region ASR (2,000+)     │
│ • Unified Worker Process        │ • Kubernetes HPA on Queue Depth │ • Event-Driven Kafka Chunks     │
│ • SQLite WAL Engine             │ • Postgres + Read Replicas      │ • Citus Sharding by Health System│
│ • Keyset Cursor Pagination      │ • Two-Tier Summary/Detail Views │ • S3 Parquet Lakehouse for ML   │
└─────────────────────────────────┴─────────────────────────────────┴─────────────────────────────────┘
```

### On-Slide Content
- **1. Search Extensibility**:
  - Temporal filtering (`createdAfter`, `createdBefore`), Patient MRN, Department context, and Full-Text Search (FTS5/BM25).
- **2. Why Pagination Matters Across All Time**:
  - Unpaginated searches over 6 months return 12.5 MB payloads, blocking the Node.js event loop during JSON serialization.
  - **MVP**: Bounded limit (`50`, max `100`).
  - **V2**: **Keyset Cursor Pagination** (`WHERE (created_at, job_id) < (:time, :id)`) delivering constant **$O(1)$ query speed**, eliminating $O(N)$ `OFFSET` scanning.
  - **Payload Optimization**: List views return a 300-byte summary; full 25 KB transcripts load on-demand (**80x network reduction**).
- **3. Scaling Roadmap (10x $\rightarrow$ 100x)**:
  - Transitioning from monolithic processes to Kubernetes auto-scaling, distributed Redis rate limiting, and Apache Kafka event streaming.

### Speaker Script (5 minutes)
> "To close our technical design, I want to address future extensibility and how this system scales from 1,000 to 100,000 daily active clinicians.
> 
> In the interview prompt, we were asked about searching across all time. In our MVP, we filter by `userId` and `jobStatus`. But in an enterprise hospital setting, clinicians need four additional dimensions:
> 1. Temporal date ranges for shift handoffs and billing audits—a Low effort task taking 1–2 days with a composite index.
> 2. Patient MRN cross-referencing Epic and Cerner charts—Low effort taking 2–3 days.
> 3. Departmental filtering for cardiology or emergency medicine—Medium effort.
> 4. Full-text keyword search across narrative transcripts—a High effort 2–3 week initiative utilizing SQLite FTS5 or Elasticsearch with medical stemmers.
> 
> However, searching across all time introduces a major bottleneck: **response serialization**.
> If an active doctor searches 6 months of history, 500 visits equal 12.5 megabytes of JSON text. Serializing 12.5 MB of JSON in Node.js runs synchronously on the main thread, blocking all other requests for several hundred milliseconds!
> 
> Our design addresses this in two ways:
> First, in V2 we implement **Keyset Cursor Pagination**. Instead of slow `OFFSET 50000` scans which degrade to $O(N)$, our cursors use a composite index on `(created_at, job_id)`. Every page executes in constant $O(1)$ time regardless of whether you are viewing yesterday or three years ago.
> Second, we separate **List Views** from **Detail Views**. The search endpoint returns a 300-byte metadata snippet. A 50-encounter page drops from 1.25 megabytes to just 15 kilobytes—an 80x reduction in network payload.
> 
> Finally, our 100x roadmap:
> At 10,000 DAU, we transition our worker pool to Kubernetes pods auto-scaling on queue depth, with a Redis distributed token bucket for rate limiting. At 100,000 DAU, we shard our PostgreSQL database by hospital tenant using Citus and stream audio chunk events through Apache Kafka.
> 
> Thank you, and I'd be glad to open up the floor to any technical questions."

### Anticipated Interviewer Q&A
- **Q: How would you prevent a doctor from seeing another doctor's patient transcripts in the Search API?**  
  *A: In production, the `userId` filter is not passed as an untrusted query parameter from the client. It is extracted server-side from the verified JWT / OAuth bearer token issued by the hospital's Identity Provider, enforcing strict tenant and user-level data isolation.*

---

## Summary Checklist for the Presentation Day
1. **Live Walkthrough Demo Ready**: Run `npm run demo` in terminal to show the 60-second end-to-end script demonstrating sub-20s latency, flakiness handling, search filtering, and metrics.
2. **Automated Tests Verified**: Run `npm test` to prove all 5 scenarios pass with 100% reliability.
3. **Architecture Reference**: Have `TECHNICAL_DESIGN.md` open for deep-dive equation or SQL verification.
