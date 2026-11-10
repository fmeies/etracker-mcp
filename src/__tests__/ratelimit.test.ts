import { beforeEach, describe, expect, it } from "vitest";
import { createRateLimiter, type RateLimiter, type RateLimitResult } from "../ratelimit.js";

const BURST_WINDOW_MS = 10_000;
const WINDOW_MS = 5 * 60_000;

let clock: number;
let limiter: RateLimiter;

beforeEach(() => {
  clock = 0;
  limiter = createRateLimiter(() => clock);
});

/** Acquires and immediately releases, i.e. a call that finished instantly. */
function call(partnerId = "partner-a"): RateLimitResult {
  const result = limiter.acquire(partnerId);
  if (result.allowed) result.release();
  return result;
}

/** Makes `count` completed calls, spaced so the burst guard never triggers. */
function callsSpacedOut(count: number, partnerId: (i: number) => string = () => "partner-a"): void {
  for (let i = 0; i < count; i++) {
    expect(call(partnerId(i)).allowed).toBe(true);
    clock += BURST_WINDOW_MS / 8 + 1;
  }
}

function retryAfter(result: RateLimitResult): number {
  if (result.allowed) throw new Error("expected the call to be refused");
  return result.retryAfterMs;
}

describe("rate limiter", () => {
  it("allows a single call", () => {
    expect(call().allowed).toBe(true);
  });

  it("blocks at the burst limit (8 calls / 10 s) with a positive retry delay", () => {
    for (let i = 0; i < 8; i++) call();
    expect(retryAfter(call())).toBe(BURST_WINDOW_MS);
  });

  it("frees burst capacity as calls slide out of the window", () => {
    for (let i = 0; i < 8; i++) call();
    clock = BURST_WINDOW_MS;
    expect(call().allowed).toBe(true);
  });

  it("blocks at the per-partner limit (20 calls / 5 min)", () => {
    callsSpacedOut(20);
    expect(call("partner-a").allowed).toBe(false);
    expect(call("partner-b").allowed).toBe(true);
  });

  it("blocks at the global limit (40 calls / 5 min) across partners", () => {
    callsSpacedOut(40, (i) => `partner-${i}`);
    expect(call("partner-new").allowed).toBe(false);
  });

  it("never allows more than 40 calls in any sliding 5-minute span", () => {
    const allowedAt: number[] = [];
    // Hammer the limiter every second for 15 minutes across many partners
    for (clock = 0; clock < 3 * WINDOW_MS; clock += 1_000) {
      if (call(`partner-${clock % 7}`).allowed) allowedAt.push(clock);
    }
    for (const start of allowedAt) {
      const inSpan = allowedAt.filter((t) => t >= start && t < start + WINDOW_MS).length;
      expect(inSpan).toBeLessThanOrEqual(40);
    }
  });

  it("does not record a refused call in any window", () => {
    callsSpacedOut(20); // partner-a is capped; 20 global slots used
    for (let i = 0; i < 50; i++) call("partner-a"); // all refused
    callsSpacedOut(20, () => "partner-b"); // would fail if refusals had used global slots
  });

  it("caps parallel in-flight calls at 8 and frees a slot on release", () => {
    const held = Array.from({ length: 8 }, (_, i) => limiter.acquire(`partner-${i}`));
    expect(held.every((r) => r.allowed)).toBe(true);
    clock += BURST_WINDOW_MS; // burst window clear, so only the parallel guard can refuse
    expect(limiter.acquire("partner-x").allowed).toBe(false);

    const first = held[0];
    if (first.allowed) first.release();
    expect(limiter.acquire("partner-x").allowed).toBe(true);
  });

  it("ignores a second release of the same slot", () => {
    const held = Array.from({ length: 8 }, () => limiter.acquire("partner-a"));
    const first = held[0];
    if (first.allowed) {
      first.release();
      first.release();
    }
    clock += BURST_WINDOW_MS;
    expect(limiter.acquire("partner-b").allowed).toBe(true);
    expect(limiter.acquire("partner-c").allowed).toBe(false); // only one slot was actually freed
  });
});
