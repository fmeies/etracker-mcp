import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test resets the module so the in-memory store starts empty.
beforeEach(() => vi.resetModules());
afterEach(() => vi.useRealTimers());

describe("cacheGet / cacheSet", () => {
  it("returns undefined for a missing key", async () => {
    const { cacheGet } = await import("../cache.js");
    expect(cacheGet("missing")).toBeUndefined();
  });

  it("returns the stored value", async () => {
    const { cacheGet, cacheSet } = await import("../cache.js");
    cacheSet("k", { x: 1 });
    expect(cacheGet("k")).toEqual({ x: 1 });
  });

  it("returns undefined after the TTL has expired", async () => {
    vi.useFakeTimers();
    const { cacheGet, cacheSet } = await import("../cache.js");
    cacheSet("k", "value");
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(cacheGet("k")).toBeUndefined();
  });

  it("overwrites an existing key", async () => {
    const { cacheGet, cacheSet } = await import("../cache.js");
    cacheSet("k", "first");
    cacheSet("k", "second");
    expect(cacheGet("k")).toBe("second");
  });

  it("evicts the oldest entry when MAX_CACHE_SIZE is reached", async () => {
    const { cacheGet, cacheSet } = await import("../cache.js");
    for (let i = 0; i < 2000; i++) cacheSet(`key-${i}`, i);
    // key-0 should still be present before the evicting write
    expect(cacheGet("key-0")).toBe(0);
    // one more entry pushes key-0 out
    cacheSet("key-2000", 2000);
    expect(cacheGet("key-0")).toBeUndefined();
    expect(cacheGet("key-2000")).toBe(2000);
  });
});

describe("makeCacheKey", () => {
  it("produces the same key regardless of property insertion order", async () => {
    const { makeCacheKey } = await import("../cache.js");
    const k1 = makeCacheKey("tool", { b: 2, a: 1 });
    const k2 = makeCacheKey("tool", { a: 1, b: 2 });
    expect(k1).toBe(k2);
  });

  it("prefixes the key with the tool name", async () => {
    const { makeCacheKey } = await import("../cache.js");
    expect(makeCacheKey("list_reports", { t: "abc" })).toMatch(/^list_reports:/);
  });

  it("produces different keys for different tools", async () => {
    const { makeCacheKey } = await import("../cache.js");
    const k1 = makeCacheKey("tool_a", { t: "abc" });
    const k2 = makeCacheKey("tool_b", { t: "abc" });
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different params", async () => {
    const { makeCacheKey } = await import("../cache.js");
    const k1 = makeCacheKey("tool", { t: "abc", reportId: "EATime" });
    const k2 = makeCacheKey("tool", { t: "abc", reportId: "EAPage" });
    expect(k1).not.toBe(k2);
  });

  it("produces the same key regardless of nested key order", async () => {
    const { makeCacheKey } = await import("../cache.js");
    const k1 = makeCacheKey("tool", { keyfigureFilter: [{ keyfigure: "visits", input: 1, type: "gt" }] });
    const k2 = makeCacheKey("tool", { keyfigureFilter: [{ type: "gt", input: 1, keyfigure: "visits" }] });
    expect(k1).toBe(k2);
  });

  it("produces different keys for different nested filter values", async () => {
    const { makeCacheKey } = await import("../cache.js");
    const k1 = makeCacheKey("tool", { reportId: "EATime", attributeFilter: [{ attributeId: "page", input: "/shop" }] });
    const k2 = makeCacheKey("tool", { reportId: "EATime", attributeFilter: [{ attributeId: "page", input: "/blog" }] });
    expect(k1).not.toBe(k2);
  });
});

describe("cache size bound", () => {
  const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  const CHARS_PER_ENTRY = 8 * 1024 * 1024; // ~16 MB per entry once serialized as UTF-16

  it("evicts the oldest entries to stay under the memory budget", async () => {
    const { cacheGet, cacheSet, cacheSizeBytes } = await import("../cache.js");
    const large = "x".repeat(CHARS_PER_ENTRY);
    for (let i = 0; i < 5; i++) cacheSet(`k${i}`, large);
    expect(cacheSizeBytes()).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(cacheGet("k0")).toBeUndefined();
    expect(cacheGet("k4")).toBe(large);
  });

  it("does not cache a value larger than the whole budget", async () => {
    const { cacheGet, cacheSet, cacheSizeBytes } = await import("../cache.js");
    cacheSet("small", "keep me");
    cacheSet("huge", "x".repeat(MAX_TOTAL_BYTES));
    expect(cacheGet("huge")).toBeUndefined();
    expect(cacheGet("small")).toBe("keep me");
    expect(cacheSizeBytes()).toBeGreaterThan(0);
  });

  it("frees the old size when a key is overwritten", async () => {
    const { cacheSet, cacheSizeBytes } = await import("../cache.js");
    cacheSet("k", "x".repeat(1000));
    const afterFirst = cacheSizeBytes();
    cacheSet("k", "x".repeat(1000));
    expect(cacheSizeBytes()).toBe(afterFirst);
  });
});

