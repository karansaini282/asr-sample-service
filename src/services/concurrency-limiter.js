import { CONFIG } from "../config.js";

/**
 * Strict Concurrency Limiter (Asynchronous Semaphore)
 * Guarantees that at most `maxConcurrency` tasks are executing simultaneously.
 * Upstream ASR vendor enforces strict <= 100 simultaneous requests.
 */
export class ConcurrencyLimiter {
  constructor(maxConcurrency = CONFIG.MAX_CONCURRENT_ASR_REQUESTS) {
    if (maxConcurrency <= 0) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    this.maxConcurrency = maxConcurrency;
    this.activeCount = 0;
    this.queue = [];
    this.peakActiveCount = 0;
    this.totalAcquired = 0;
    this.totalReleased = 0;
  }

  /**
   * Acquire a permit. Resolves immediately if activeCount < maxConcurrency,
   * otherwise enqueues a resolver in FIFO order.
   */
  async acquire() {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      this.totalAcquired++;
      if (this.activeCount > this.peakActiveCount) {
        this.peakActiveCount = this.activeCount;
      }
      return;
    }

    // Wait in FIFO queue
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.activeCount++;
        this.totalAcquired++;
        if (this.activeCount > this.peakActiveCount) {
          this.peakActiveCount = this.activeCount;
        }
        resolve();
      });
    });
  }

  /**
   * Release a permit. If waiters exist, immediately grants permit to the next in line.
   */
  release() {
    if (this.activeCount <= 0) {
      return;
    }

    this.activeCount--;
    this.totalReleased++;

    if (this.queue.length > 0 && this.activeCount < this.maxConcurrency) {
      const nextWaiter = this.queue.shift();
      if (nextWaiter) {
        nextWaiter();
      }
    }
  }

  /**
   * Executes an async operation with guaranteed permit acquisition and release.
   */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  getMetrics() {
    return {
      maxConcurrency: this.maxConcurrency,
      activeCount: this.activeCount,
      queueLength: this.queue.length,
      peakActiveCount: this.peakActiveCount,
      totalAcquired: this.totalAcquired,
      totalReleased: this.totalReleased,
    };
  }
}

// Global default limiter singleton
export const defaultLimiter = new ConcurrencyLimiter();
