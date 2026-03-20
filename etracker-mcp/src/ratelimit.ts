/**
 * Three-layer rate limiting against etracker upstream (50 req / 5 min, max 10 parallel):
 *
 * 1. Burst guard (global):   max 8 req / 10 sec  — stays well under the 10-parallel limit
 * 2. Global window:          max 40 req / 5 min  — 80% of etracker's quota, leaves headroom for retries
 * 3. Per-partner window:     max 20 req / 5 min  — so one partner can never exhaust the global budget alone
 */

const BURST_WINDOW_MS = 10_000;   // 10 seconds
const BURST_MAX = 8;

const WINDOW_MS = 5 * 60_000;    // 5 minutes
const MAX_GLOBAL = 40;            // 80% of etracker's 50
const MAX_PER_PARTNER = 20;       // half of global so ≥2 partners can always coexist

interface Bucket {
  count: number;
  resetAt: number;
}

const partnerBuckets = new Map<string, Bucket>();
const globalBucket: Bucket = { count: 0, resetAt: Date.now() + WINDOW_MS };
const burstBucket: Bucket = { count: 0, resetAt: Date.now() + BURST_WINDOW_MS };

function refreshBucket(bucket: Bucket, windowMs: number): Bucket {
  if (Date.now() >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = Date.now() + windowMs;
  }
  return bucket;
}

function tryConsume(bucket: Bucket, limit: number): { allowed: boolean; retryAfterMs: number } {
  if (bucket.count >= limit) {
    return { allowed: false, retryAfterMs: bucket.resetAt - Date.now() };
  }
  bucket.count++;
  return { allowed: true, retryAfterMs: 0 };
}

function undo(bucket: Bucket): void {
  bucket.count = Math.max(0, bucket.count - 1);
}

export function checkRateLimit(partnerKey: string): { allowed: boolean; retryAfterMs: number } {
  refreshBucket(burstBucket, BURST_WINDOW_MS);
  refreshBucket(globalBucket, WINDOW_MS);

  // Layer 1: burst guard
  const burst = tryConsume(burstBucket, BURST_MAX);
  if (!burst.allowed) return burst;

  // Layer 2: global 5-min window
  const global = tryConsume(globalBucket, MAX_GLOBAL);
  if (!global.allowed) {
    undo(burstBucket);
    return global;
  }

  // Layer 3: per-partner 5-min window
  let partnerBucket = partnerBuckets.get(partnerKey);
  if (!partnerBucket || Date.now() >= partnerBucket.resetAt) {
    partnerBucket = { count: 0, resetAt: Date.now() + WINDOW_MS };
    partnerBuckets.set(partnerKey, partnerBucket);
  }
  const partner = tryConsume(partnerBucket, MAX_PER_PARTNER);
  if (!partner.allowed) {
    undo(burstBucket);
    undo(globalBucket);
    return partner;
  }

  return { allowed: true, retryAfterMs: 0 };
}
