import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test resets the module so bucket state starts at zero.
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("checkRateLimit", () => {
  it("allows a single request", async () => {
    const { checkRateLimit } = await import("../ratelimit.js");
    expect(checkRateLimit("partner-a").allowed).toBe(true);
  });

  it("blocks at the burst limit (8 req / 10 s)", async () => {
    const { checkRateLimit } = await import("../ratelimit.js");
    for (let i = 0; i < 8; i++) checkRateLimit("partner-a");
    const result = checkRateLimit("partner-a");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets the burst bucket after 10 s", async () => {
    const { checkRateLimit } = await import("../ratelimit.js");
    for (let i = 0; i < 8; i++) checkRateLimit("partner-a");
    vi.advanceTimersByTime(10_001);
    expect(checkRateLimit("partner-a").allowed).toBe(true);
  });

  it("blocks at the global limit (40 req / 5 min)", async () => {
    const { checkRateLimit } = await import("../ratelimit.js");
    // Use a different partner per request to avoid the per-partner cap,
    // and reset the burst bucket every 8 requests.
    for (let i = 0; i < 40; i++) {
      if (i > 0 && i % 8 === 0) vi.advanceTimersByTime(10_001);
      checkRateLimit(`partner-${i}`);
    }
    vi.advanceTimersByTime(10_001); // ensure burst is not the reason for blocking
    const result = checkRateLimit("partner-new");
    expect(result.allowed).toBe(false);
  });

  it("blocks at the per-partner limit (20 req / 5 min)", async () => {
    const { checkRateLimit } = await import("../ratelimit.js");
    for (let i = 0; i < 20; i++) {
      if (i > 0 && i % 8 === 0) vi.advanceTimersByTime(10_001);
      checkRateLimit("partner-a");
    }
    vi.advanceTimersByTime(10_001);
    const result = checkRateLimit("partner-a");
    expect(result.allowed).toBe(false);
  });

  it("partner limits are independent of each other", async () => {
    const { checkRateLimit } = await import("../ratelimit.js");
    // Exhaust partner-a
    for (let i = 0; i < 20; i++) {
      if (i > 0 && i % 8 === 0) vi.advanceTimersByTime(10_001);
      checkRateLimit("partner-a");
    }
    vi.advanceTimersByTime(10_001);
    // partner-b should still be allowed
    expect(checkRateLimit("partner-b").allowed).toBe(true);
  });

  it("returns a positive retryAfterMs when blocked", async () => {
    const { checkRateLimit } = await import("../ratelimit.js");
    for (let i = 0; i < 8; i++) checkRateLimit("partner-a");
    const { retryAfterMs } = checkRateLimit("partner-a");
    expect(retryAfterMs).toBeGreaterThan(0);
  });
});
