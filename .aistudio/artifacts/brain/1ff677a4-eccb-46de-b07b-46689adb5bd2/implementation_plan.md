# Implementation Plan: Google Slides Presentation Script for Technical Design Walkthrough

This plan outlines the structure, slide content, visual diagrams, and speaker notes to prepare a comprehensive 10-slide presentation deck designed for a 45–60 minute technical design walk-through.

---

## Slide Deck Architecture (10 Slides)

### Slide 1: Title & Context
- **Title**: High-Throughput Asynchronous Audio Transcription Service
- **Subtitle**: Architectural Deep-Dive & System Design for Clinical Encounter Ingestion
- **Visuals**: Ambience clinical encounter workflow diagram (Audio Capture $\rightarrow$ Chunker $\rightarrow$ Backend Service $\rightarrow$ Scribe Note).
- **Speaker Focus**: Hook the interviewers with the clinical context (30–120 min patient visits, doctor note generation, sub-20s urgency).

### Slide 2: Core Operational Constraints & SLA Requirements
- **Content**: The 4 non-negotiable requirements (Strict $\le 100$ ASR vendor rate limit, Sub-20s latency SLA, 5% transient error rate + permanent failure handling, restart durability).
- **Visuals**: Comparison matrix of SLAs, failure modes, and penalties (e.g. 429 vendor ban).
- **Speaker Focus**: Why standard naive async architectures fail under these specific constraints.

### Slide 3: End-to-End System Architecture
- **Content**: Component flow diagram from HTTP request to vendor response.
- **Visuals**: Clean ASCII/Box architectural diagram showing Fastify API Gateway, `JobService` (Domain Authority), Data Store (SQLite WAL), `WorkerPool` (Execution Orchestrator), `ConcurrencyLimiter` (FIFO Semaphore), and `AsrClient`.
- **Speaker Focus**: Walk through the life of a request end-to-end.

### Slide 4: Sub-20s Latency via Parallel Chunk Fan-Out
- **Content**: Breaking down 30-minute encounters into 6 chunks ($\le 5$ min each).
- **Visuals**: Timeline comparison: Serial execution ($6 \times 7.5\text{s} = 45\text{s}$) vs. Parallel execution ($\max(t_i) \approx 7.5\text{s} \pm 2.5\text{s} \approx 10\text{s}$).
- **Speaker Focus**: Parallel fan-out using `Promise.allSettled()`, chronological narrative reconstruction using `chunk_index`.

### Slide 5: Strict Concurrency Enforcement ($\le 100$)
- **Content**: Asynchronous Semaphore and Rate Limiting.
- **Visuals**: State diagram of `activeCount`, FIFO wait-queue, and permit release lifecycle.
- **Speaker Focus**: Why rate-limiting before the network request prevents vendor 429 bans; transition from in-memory semaphore to distributed Redis token bucket for multi-node deployments.

### Slide 6: Fault Tolerance, Exponential Backoff & Graceful Degradation
- **Content**: Bounded exponential backoff with randomized jitter and `PARTIAL_SUCCESS` state machine.
- **Visuals**: Retry timeline ($1\text{s}, 2\text{s}, 4\text{s} \pm \text{jitter}$) and stitched transcript mockup highlighting `[Transcript unavailable for audio-file-8.wav]`.
- **Speaker Focus**: Differentiating transient 500s from permanent failures (404/audio-file-8); preserving valid chunks while alerting clinicians to missing segments.

### Slide 7: Authoritative Persistence & Crash Durability
- **Content**: SQLite WAL mode and process restart reconciliation.
- **Visuals**: Three-file SQLite WAL layout (`.db`, `.db-wal`, `.db-shm`), read/write zero-lock concurrency, and restart recovery flow (`recoverUnfinishedJobs`).
- **Speaker Focus**: Why `PRAGMA synchronous = NORMAL` provides 10–50x write throughput with zero risk of database corruption; how unfinished jobs auto-resume without re-transcribing completed chunks.

### Slide 8: Domain-Driven Design & Separation of Concerns
- **Content**: Clean Architecture: `JobService` vs. `WorkerPool`.
- **Visuals**: UML-style interaction sequence showing `WorkerPool` with zero database knowledge, communicating solely via domain events (`claimChunk`, `recordChunkSuccess`, `finalizeJob`).
- **Speaker Focus**: Elimination of repository leakage and query anti-patterns (`WHERE 1=1` replaced with dynamic query builder); testability and maintainability.

### Slide 9: Napkin Math & System Sizing
- **Content**: First-principles derivations of throughput, text volume, and DAU ceilings.
- **Visuals**: Key metrics callout cards (140 WPM $\rightarrow$ 4,200 words $\rightarrow$ 25 KB/encounter; 10,000 visits/day $\rightarrow$ 250 MB/day; 100-connection ceiling $\rightarrow$ 3,200 DAU bottleneck).
- **Speaker Focus**: Demonstrating analytical rigor with concrete numbers and showing where backpressure starts.

### Slide 10: Extensibility, Future Search Roadmap & Scale (10x $\rightarrow$ 100x)
- **Content**: Expanding search dimensions (Temporal, MRN, Department, FTS5/Elasticsearch) with Low/Medium/High estimates, keyset cursor pagination vs. $O(N)$ offset degradation, summary vs. detail payloads, and the 100x Kubernetes/Kafka roadmap.
- **Visuals**: Scalability tier table and Keyset pagination query diagram.
- **Speaker Focus**: Showing forward-thinking system maturity and answering common follow-up interview questions before they are asked.

---

## Deliverable File
Create `PRESENTATION_DECK.md` containing:
1. **Slide Title & Layout Directives** (exact visual layout suggestions for Google Slides).
2. **On-Slide Content** (concise, scannable bullet points and diagrams).
3. **Word-for-Word Speaker Script** (timed for 4–5 minutes per slide, including anticipated interviewer questions and responses).
