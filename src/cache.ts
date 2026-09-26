/**
 * Simple in-memory cache with 5-minute TTL.
 */

const TTL_MS = 5 * 60_000;
const MAX_CACHE_SIZE = 2000;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function cacheSet<T>(key: string, value: T): void {
  if (store.size >= MAX_CACHE_SIZE) {
    // evict oldest entry (Map preserves insertion order)
    store.delete(store.keys().next().value!);
  }
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

export function makeCacheKey(tool: string, params: Record<string, unknown>): string {
  // A replacer array would also whitelist nested keys and drop filter contents, so sort the entries instead
  const sortedParams = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
  return `${tool}:${JSON.stringify(sortedParams)}`;
}
