import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Cache, cached } from "./cache.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

it("starts the TTL after a slow factory resolves", async () => {
  const cache = new Cache<string>();
  const request = deferred<string>();
  const factory = vi.fn(() => request.promise);

  const first = cache.get("key", 1000, factory);
  vi.advanceTimersByTime(1500);
  request.resolve("value");
  await expect(first).resolves.toBe("value");

  await expect(cache.get("key", 1000, factory)).resolves.toBe("value");
  expect(factory).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(999);
  await expect(cache.get("key", 1000, factory)).resolves.toBe("value");
  expect(factory).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(1);
  await expect(cache.get("key", 1000, factory)).resolves.toBe("value");
  expect(factory).toHaveBeenCalledTimes(2);
});

it("expires exactly at the TTL boundary", async () => {
  const cache = new Cache<number>();
  const factory = vi.fn(async () => 1);

  await cache.get("key", 1000, factory);
  vi.advanceTimersByTime(999);
  await expect(cache.get("key", 1000, factory)).resolves.toBe(1);
  expect(factory).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(1);
  await expect(cache.get("key", 1000, factory)).resolves.toBe(1);
  expect(factory).toHaveBeenCalledTimes(2);
});

it("shares one factory call between concurrent callers", async () => {
  const cache = new Cache<string>();
  const request = deferred<string>();
  const factory = vi.fn(() => request.promise);

  const first = cache.get("key", 1000, factory);
  const second = cache.get("key", 1000, factory);
  expect(factory).toHaveBeenCalledTimes(1);

  request.resolve("value");
  await expect(Promise.all([first, second])).resolves.toEqual(["value", "value"]);
});

it("retries after a rejected factory", async () => {
  const cache = new Cache<string>();
  const error = new Error("upstream failed");
  const factory = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce("recovered");

  await expect(cache.get("key", 1000, factory)).rejects.toBe(error);
  await expect(cache.get("key", 1000, factory)).resolves.toBe("recovered");
  expect(factory).toHaveBeenCalledTimes(2);
});

it("retries after a factory throws synchronously", async () => {
  const cache = new Cache<string>();
  const error = new Error("synchronous failure");
  const factory = vi
    .fn<() => Promise<string>>()
    .mockImplementationOnce(() => {
      throw error;
    })
    .mockResolvedValueOnce("recovered");

  await expect(cache.get("key", 1000, factory)).rejects.toBe(error);
  await expect(cache.get("key", 1000, factory)).resolves.toBe("recovered");
  expect(factory).toHaveBeenCalledTimes(2);
});

it.each([0, -1000])("bypasses the cache when ttlMs is %i", async (ttlMs) => {
  const cache = new Cache<number>();
  await cache.get("key", 1000, async () => 1);
  const factory = vi.fn(async () => 2);

  await expect(cached(cache, "key", ttlMs, factory)).resolves.toBe(2);
  await expect(cached(cache, "key", ttlMs, factory)).resolves.toBe(2);
  expect(factory).toHaveBeenCalledTimes(2);
});
