import { TranscriptMocks } from "../../mock-transcripts.js";

const DELAY_MS = 5_000;
const FAILURE_RATE = 1 / 20;
const MAX_REQUESTS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const addRandomRequestLatency = async (delayMs = DELAY_MS) => {
  if (delayMs > 0) {
    await sleep(delayMs + Math.random() * delayMs);
  }
};

export function registerAsrMockRoutes(fastify, options = {}) {
  const customDelayMs = options.customDelayMs !== undefined ? options.customDelayMs : DELAY_MS;
  const failureRate = options.failureRate !== undefined ? options.failureRate : FAILURE_RATE;
  const maxRequests = options.maxRequests || MAX_REQUESTS;

  let currentRequests = 0;

  fastify.addHook("onRequest", async (request, reply) => {
    // Only apply concurrency cap hook to /get-asr-output
    if (!request.url.startsWith("/get-asr-output")) {
      return;
    }

    if (currentRequests + 1 > maxRequests) {
      return reply.code(429).send({ error: "Too many requests" });
    }

    currentRequests++;
  });

  ["onResponse", "onRequestAbort"].forEach((hook) => {
    fastify.addHook(hook, async (request) => {
      if (request.url.startsWith("/get-asr-output")) {
        currentRequests = Math.max(0, currentRequests - 1);
      }
    });
  });

  fastify.get("/get-asr-output", async function handler(request, reply) {
    const { path } = request.query;

    await addRandomRequestLatency(customDelayMs);

    const file = TranscriptMocks.get(path);
    if (!file) {
      return reply.code(404).send({ error: "File not found" });
    }

    if (file.shouldError || Math.random() < failureRate) {
      return reply.code(500).send({ error: "Internal server error" });
    }

    return { path, transcript: file.text };
  });
}
