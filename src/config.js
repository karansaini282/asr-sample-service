import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONFIG = {
  // Server port & host
  PORT: parseInt(process.env.PORT || "3000", 10),
  HOST: process.env.HOST || "0.0.0.0",

  // Upstream ASR configuration
  ASR_BASE_URL: process.env.ASR_BASE_URL || "http://127.0.0.1:3000",
  ASR_ENDPOINT: "/get-asr-output",

  // Strict Concurrency Cap (<= 100)
  MAX_CONCURRENT_ASR_REQUESTS: parseInt(process.env.MAX_CONCURRENT_ASR_REQUESTS || "100", 10),

  // Retry & Backoff Configuration
  MAX_RETRIES: 3,
  INITIAL_BACKOFF_MS: 1000,
  BACKOFF_MULTIPLIER: 2,
  MAX_JITTER_MS: 500,

  // Chunk processing timeout
  CHUNK_REQUEST_TIMEOUT_MS: 25_000,

  // Database location
  DB_PATH: process.env.DB_PATH || path.resolve(__dirname, "../../data/transcription.db"),

  // Worker polling interval for pending jobs (when decoupled)
  WORKER_POLL_INTERVAL_MS: 500,
  WORKER_LEASE_TIMEOUT_SEC: 60,
};
