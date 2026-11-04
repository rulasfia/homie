interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface PendingEntry<T> {
  promise: Promise<T>;
}

/**
 * Simple in-memory TTL cache. Concurrent requests for the same key share the
 * same pending promise so only one backend call runs at a time. The TTL starts
 * when that promise resolves, so upstream latency is not counted against it.
 */
export class Cache<T> {
  private entries = new Map<string, CacheEntry<T> | PendingEntry<T>>();

  async get(key: string, ttlMs: number, factory: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);

    if (existing && "expiresAt" in existing && existing.expiresAt > Date.now()) {
      return existing.value;
    }

    if (existing && "promise" in existing) {
      return existing.promise;
    }

    const promise = factory()
      .then((value) => {
        this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
      })
      .catch((err) => {
        this.entries.delete(key);
        throw err;
      });

    this.entries.set(key, { promise });
    return promise;
  }
}

/** Runs the factory directly when ttlMs is 0 or negative, otherwise uses the cache. */
export async function cached<T>(
  cache: Cache<T>,
  key: string,
  ttlMs: number,
  factory: () => Promise<T>,
): Promise<T> {
  if (ttlMs <= 0) return factory();
  return cache.get(key, ttlMs, factory);
}
