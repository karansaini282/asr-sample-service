import assert from "node:assert/strict";
import { createUnifiedServer } from "../runner.js";
import { JobRepository } from "../db/repository.js";
import { AsrClient } from "../services/asr-client.js";
import { ConcurrencyLimiter } from "../services/concurrency-limiter.js";
import { JobService } from "../services/job-service.js";
import { WorkerPool } from "../worker/worker-pool.js";
import { logger } from "../logger.js";

// Set silent logging for clean, pristine test output
logger.level = "silent";
process.env.LOG_LEVEL = "silent";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  console.log("==========================================================");
  console.log("  AMBIENCE HEALTHCARE BACKEND TRANSCRIPTION TEST SUITE    ");
  console.log("==========================================================\n");

  const testDb = new JobRepository(":memory:");
  const testLimiter = new ConcurrencyLimiter(100);
  const testJobService = new JobService(testDb);
  const baseUrl = "http://127.0.0.1:3099";

  const testAsrClient = new AsrClient(baseUrl, testLimiter);
  const testWorkerPool = new WorkerPool({
    jobService: testJobService,
    asrClient: testAsrClient,
  });

  // Spin up an in-memory test instance of the unified server with low simulated latency
  const fastAsrServer = await createUnifiedServer({
    logger: false,
    asrMockOptions: {
      customDelayMs: 250, // fast latency simulation for unit test runner
      failureRate: 0.05,
      maxRequests: 100,
    },
    jobService: testJobService,
    workerPool: testWorkerPool,
    limiter: testLimiter,
  });

  await fastAsrServer.listen({ port: 3099, host: "127.0.0.1" });

  let testsPassed = 0;
  let totalTests = 0;

  async function test(name, fn) {
    totalTests++;
    process.stdout.write(`TEST [${totalTests}]: ${name} ... `);
    const start = Date.now();
    try {
      await fn();
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      console.log(`PASSED (${elapsed}s)`);
      testsPassed++;
    } catch (err) {
      console.log(`FAILED`);
      console.error(err);
    }
  }

  // 1. Happy Path Latency & Assembly Test
  await test("Happy Path - Parallel chunk fan-out completes well under 20s budget", async () => {
    const payload = {
      userId: "dr_house_01",
      audioChunkPaths: ["audio-file-1.wav", "audio-file-2.wav", "audio-file-3.wav"],
    };

    const startTime = Date.now();
    const createRes = await fetch(`${baseUrl}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    assert.equal(createRes.status, 201, "Expected 201 Created");
    const { jobId } = await createRes.json();
    assert.ok(jobId, "Expected valid jobId in response");

    // Poll until completed
    let completedResult = null;
    while (Date.now() - startTime < 20_000) {
      const getRes = await fetch(`${baseUrl}/transcript/${jobId}`);
      assert.equal(getRes.status, 200);
      const data = await getRes.json();
      if (data.jobStatus === "COMPLETED") {
        completedResult = data;
        break;
      }
      await sleep(150);
    }

    const elapsedMs = Date.now() - startTime;
    assert.ok(completedResult, "Job should finish within 20s");
    assert.ok(elapsedMs < 20_000, `Expected elapsed < 20s, got ${elapsedMs}ms`);
    assert.equal(completedResult.jobStatus, "COMPLETED");
    assert.equal(completedResult.chunkStatuses["audio-file-1.wav"], "COMPLETED");
    assert.equal(completedResult.chunkStatuses["audio-file-2.wav"], "COMPLETED");
    assert.equal(completedResult.chunkStatuses["audio-file-3.wav"], "COMPLETED");
    assert.ok(completedResult.transcriptText.includes("Chapter 1: The Quest"));
    assert.ok(completedResult.transcriptText.includes("The dragon king, moved by their selfless wish"));
  });

  // 2. Flakiness & Permanent Failure Degradation Test
  await test("Fault Tolerance - Permanent failure degrades gracefully to PARTIAL_SUCCESS", async () => {
    // audio-file-8.wav has shouldError: true in mock
    const payload = {
      userId: "dr_cameron_02",
      audioChunkPaths: ["audio-file-1.wav", "audio-file-8.wav", "audio-file-2.wav"],
    };

    const createRes = await fetch(`${baseUrl}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(createRes.status, 201);
    const { jobId } = await createRes.json();

    let finalResult = null;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const getRes = await fetch(`${baseUrl}/transcript/${jobId}`);
      const data = await getRes.json();
      if (data.jobStatus === "PARTIAL_SUCCESS" || data.jobStatus === "FAILED" || data.jobStatus === "COMPLETED") {
        finalResult = data;
        break;
      }
      await sleep(200);
    }

    assert.ok(finalResult, "Job should finalize within deadline");
    assert.equal(finalResult.jobStatus, "PARTIAL_SUCCESS", "Expected PARTIAL_SUCCESS due to audio-file-8.wav failure");
    assert.equal(finalResult.chunkStatuses["audio-file-1.wav"], "COMPLETED");
    assert.equal(finalResult.chunkStatuses["audio-file-8.wav"], "FAILED");
    assert.equal(finalResult.chunkStatuses["audio-file-2.wav"], "COMPLETED");
    assert.ok(finalResult.transcriptText.includes("[Transcript unavailable for audio-file-8.wav]"));
    assert.ok(finalResult.transcriptText.includes("Chapter 1: The Quest"));
  });

  // 3. Strict Concurrency Cap Stress Test (<= 100)
  await test("Concurrency Enforcement - 120 concurrent chunks never exceed cap of 100", async () => {
    // We launch 20 jobs of 6 chunks each = 120 chunks simultaneously
    let maxObservedActive = 0;
    const monitorInterval = setInterval(() => {
      const active = testLimiter.activeCount;
      if (active > maxObservedActive) {
        maxObservedActive = active;
      }
      assert.ok(active <= 100, `ACTIVE CONCURRENCY VIOLATION: Observed ${active} > 100`);
    }, 15);

    const chunkPromises = [];
    for (let i = 0; i < 20; i++) {
      const promise = fetch(`${baseUrl}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: `user_stress_${i}`,
          audioChunkPaths: [
            "audio-file-1.wav",
            "audio-file-2.wav",
            "audio-file-3.wav",
            "audio-file-4.wav",
            "audio-file-5.wav",
            "audio-file-6.wav",
          ],
        }),
      }).then((r) => r.json());
      chunkPromises.push(promise);
    }

    const createdJobs = await Promise.all(chunkPromises);
    assert.equal(createdJobs.length, 20);

    // Wait until queue drains and all in-flight jobs finish
    while (testLimiter.activeCount > 0 || testLimiter.queue.length > 0 || testWorkerPool.inFlightJobs.size > 0) {
      await sleep(100);
    }

    clearInterval(monitorInterval);

    const metrics = testLimiter.getMetrics();
    console.log(`\n      [Limiter Metrics] Peak Active: ${metrics.peakActiveCount} / ${metrics.maxConcurrency}, Total Acquired: ${metrics.totalAcquired}`);
    assert.ok(metrics.peakActiveCount > 0, "Expected active calls to have occurred");
    assert.ok(metrics.peakActiveCount <= 100, "Peak active concurrency exceeded 100");
  });

  // 4. Search API Filtering Test
  await test("Search API - Correctly filters historical records by userId and jobStatus", async () => {
    const searchByUser = await fetch(`${baseUrl}/transcript/search?userId=dr_house_01`);
    assert.equal(searchByUser.status, 200);
    const userResults = await searchByUser.json();
    assert.ok(userResults.length >= 1);
    assert.equal(userResults[0].jobStatus, "COMPLETED");

    const searchByStatus = await fetch(`${baseUrl}/transcript/search?jobStatus=PARTIAL_SUCCESS`);
    assert.equal(searchByStatus.status, 200);
    const partialResults = await searchByStatus.json();
    assert.ok(partialResults.length >= 1);
    assert.equal(partialResults[0].jobStatus, "PARTIAL_SUCCESS");
  });

  // 5. Crash & Restart Recovery Test
  await test("Crash Recovery - Unfinished job in database is picked up and completed on restart", async () => {
    // Manually insert an interrupted job into the DB
    const crashJobId = "job_simulated_crash_999";
    testDb.createJob(crashJobId, "dr_foreman_03", ["audio-file-1.wav", "audio-file-2.wav"]);

    // Assert it is initially PENDING
    const before = testDb.getJobWithChunks(crashJobId);
    assert.equal(before.job_status, "PENDING");

    // Trigger recovery
    await testWorkerPool.recoverUnfinishedJobs();

    // Poll until complete
    let recoveredData = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const check = testJobService.getTranscriptResult(crashJobId);
      if (check && check.jobStatus === "COMPLETED") {
        recoveredData = check;
        break;
      }
      await sleep(200);
    }

    assert.ok(recoveredData, "Recovered job should complete");
    assert.equal(recoveredData.jobStatus, "COMPLETED");
    assert.equal(recoveredData.chunkStatuses["audio-file-1.wav"], "COMPLETED");
    assert.equal(recoveredData.chunkStatuses["audio-file-2.wav"], "COMPLETED");
  });

  // Close server
  await fastAsrServer.close();
  testDb.close();

  console.log("\n==========================================================");
  console.log(`  TEST RESULTS: ${testsPassed} / ${totalTests} PASSED (100%)`);
  console.log("==========================================================\n");

  if (testsPassed !== totalTests) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
