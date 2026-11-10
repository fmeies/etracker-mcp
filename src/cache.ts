/**
 * In-memory cache with a 5-minute TTL, bounded by entry count and by approximate
 * memory size so large report responses can't exhaust the container's memory limit.
 */

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
// JS strings are UTF-16, so a serialized character costs about two bytes in memory
const BYTES_PER_CHAR = 2;

interface Entry {
  value: unknown;
  expiresAt: number;
  bytes: number;
}

const store = new Map<string, Entry>();
let totalBytes = 0;

function approximateBytes(value: unknown): number {
  return (JSON.stringify(value)?.length ?? 0) * BYTES_PER_CHAR;
}

function remove(key: string): void {
  const entry = store.get(key);
  if (!entry) return;
  totalBytes -= entry.bytes;
  store.delete(key);
}

function evictOldest(): void {
  // Map preserves insertion order and every entry has the same TTL, so the first is the oldest
  remove(store.keys().next().value!);
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    remove(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T): void {
  const bytes = approximateBytes(value);
  remove(key);
  if (bytes > MAX_TOTAL_BYTES) return; // larger than the whole cache, so it is served uncached

  while (store.size > 0 && (store.size >= MAX_ENTRIES || totalBytes + bytes > MAX_TOTAL_BYTES)) {
    evictOldest();
  }
  store.set(key, { value, expiresAt: Date.now() + TTL_MS, bytes });
  totalBytes += bytes;
}

/** Approximate memory held by cached values, in bytes. */
export function cacheSizeBytes(): number {
  return totalBytes;
}

export function makeCacheKey(tool: string, params: Record<string, unknown>): string {
  // A replacer array would also whitelist nested keys and drop filter contents, so sort the entries instead
  const sortedParams = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
  return `${tool}:${JSON.stringify(sortedParams)}`;
}
