/**
 * Rate limiting against etracker's upstream limits (50 calls / 5 min, max 10 parallel).
 *
 * One slot is acquired per actual etracker API call (cache hits and MCP protocol
 * traffic are free) and released when the call finishes. Windows are sliding logs
 * rather than fixed buckets, so no 5-minute span can ever exceed the limit, even
 * across what would otherwise be a bucket reset.
 *
 * 1. Parallel guard (global): max 8 calls in flight — below etracker's 10
 * 2. Burst guard (global):    max 8 calls / 10 s
 * 3. Global window:           max 40 calls / 5 min — 80% of etracker's quota, leaves headroom
 * 4. Per-partner window:      max 20 calls / 5 min — one partner can never exhaust the global budget
 *
 * State is in-memory, so the limits only hold for a single replica.
 */

const MAX_PARALLEL_CALLS = 8;
// A parallel slot frees up as soon as any in-flight call finishes, so retry soon
const PARALLEL_RETRY_AFTER_MS = 1_000;

const BURST_WINDOW_MS = 10_000;
const BURST_MAX = 8;

const WINDOW_MS = 5 * 60_000;
const MAX_GLOBAL = 40;
const MAX_PER_PARTNER = 20;

export type RateLimitResult =
  | { allowed: true; release: () => void }
  | { allowed: false; retryAfterMs: number };

export interface RateLimiter {
  acquire(partnerId: string): RateLimitResult;
}

class SlidingWindow {
  private readonly timestamps: number[] = [];

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  isFull(now: number): boolean {
    while (this.timestamps.length > 0 && this.timestamps[0] <= now - this.windowMs) {
      this.timestamps.shift();
    }
    return this.timestamps.length >= this.limit;
  }

  /** Time until the oldest call leaves the window; only meaningful when full. */
  retryAfterMs(now: number): number {
    return this.timestamps[0] + this.windowMs - now;
  }

  record(now: number): void {
    this.timestamps.push(now);
  }
}

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const burst = new SlidingWindow(BURST_MAX, BURST_WINDOW_MS);
  const global = new SlidingWindow(MAX_GLOBAL, WINDOW_MS);
  // Partner IDs come only from PARTNER_API_KEYS, so this map is bounded by configuration
  const partners = new Map<string, SlidingWindow>();
  let inFlight = 0;

  function partnerWindow(partnerId: string): SlidingWindow {
    let window = partners.get(partnerId);
    if (!window) {
      window = new SlidingWindow(MAX_PER_PARTNER, WINDOW_MS);
      partners.set(partnerId, window);
    }
    return window;
  }

  return {
    acquire(partnerId: string): RateLimitResult {
      if (inFlight >= MAX_PARALLEL_CALLS) {
        return { allowed: false, retryAfterMs: PARALLEL_RETRY_AFTER_MS };
      }

      const time = now();
      const windows = [burst, global, partnerWindow(partnerId)];
      // Check every window before recording in any, so a refused call costs nothing.
      // Report the longest wait: retrying when only the shortest window frees up would fail again.
      const fullWindows = windows.filter((window) => window.isFull(time));
      if (fullWindows.length > 0) {
        return { allowed: false, retryAfterMs: Math.max(...fullWindows.map((window) => window.retryAfterMs(time))) };
      }

      for (const window of windows) window.record(time);
      inFlight++;
      let released = false;
      return {
        allowed: true,
        release: () => {
          if (released) return;
          released = true;
          inFlight--;
        },
      };
    },
  };
}

/** Process-wide limiter shared by all requests. */
export const rateLimiter = createRateLimiter();
