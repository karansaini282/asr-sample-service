import { CONFIG } from "../config.js";
import { defaultLimiter } from "./concurrency-limiter.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AsrClient {
  constructor(baseUrl = CONFIG.ASR_BASE_URL, limiter = defaultLimiter) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.limiter = limiter;
  }

  /**
   * Request transcription for a single audio file chunk.
   * Executes through the concurrency limiter and handles transient retries with exponential backoff & jitter.
   */
  async transcribeChunk(audioPath, options = {}) {
    const maxRetries = options.maxRetries ?? CONFIG.MAX_RETRIES;
    let attempt = 0;
    let lastError = null;

    while (attempt <= maxRetries) {
      try {
        const result = await this.limiter.run(async () => {
          return await this._executeHttpRequest(audioPath);
        });
        return {
          success: true,
          transcript: result.transcript,
          attempts: attempt + 1,
        };
      } catch (err) {
        lastError = err;
        attempt++;

        // If file not found (404), it's a permanent failure, do not retry
        if (err.statusCode === 404) {
          return {
            success: false,
            error: err.message,
            permanent: true,
            attempts: attempt,
          };
        }

        // If retries remain and error is transient (e.g. 500 or network timeout)
        if (attempt <= maxRetries) {
          const baseDelay = CONFIG.INITIAL_BACKOFF_MS * Math.pow(CONFIG.BACKOFF_MULTIPLIER, attempt - 1);
          const jitter = Math.floor(Math.random() * CONFIG.MAX_JITTER_MS);
          const backoffDelay = baseDelay + jitter;
          await sleep(backoffDelay);
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || "Transcription failed after retries",
      permanent: false,
      attempts: attempt,
    };
  }

  async _executeHttpRequest(audioPath) {
    const url = `${this.baseUrl}${CONFIG.ASR_ENDPOINT}?path=${encodeURIComponent(audioPath)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.CHUNK_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        let jsonError = null;
        try {
          jsonError = JSON.parse(bodyText);
        } catch (_) {}

        const errMessage = jsonError?.error || `HTTP ${response.status}: ${response.statusText}`;
        const error = new Error(errMessage);
        error.statusCode = response.status;
        error.body = bodyText;
        throw error;
      }

      const data = await response.json();
      return data;
    } catch (err) {
      if (err.name === "AbortError") {
        const timeoutError = new Error(`ASR request timed out after ${CONFIG.CHUNK_REQUEST_TIMEOUT_MS}ms`);
        timeoutError.statusCode = 504;
        throw timeoutError;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// Global default ASR client
export const defaultAsrClient = new AsrClient();
