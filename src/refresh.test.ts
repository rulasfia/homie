import { afterEach, expect, it, vi } from "vite-plus/test";
import { scheduleRefresh, singleFlight } from "./refresh.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("shares one in-flight load and starts a new one after it resolves", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  let call = 0;
  const load = vi.fn(() => (++call === 1 ? first.promise : second.promise));
  const refresh = singleFlight(load);

  const request = refresh();
  expect(refresh()).toBe(request);
  expect(load).toHaveBeenCalledTimes(1);

  first.resolve("first");
  await expect(request).resolves.toBe("first");

  const next = refresh();
  expect(next).not.toBe(request);
  expect(load).toHaveBeenCalledTimes(2);

  second.resolve("second");
  await expect(next).resolves.toBe("second");
});

it("releases the guard after a rejection so a later call can retry", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  let call = 0;
  const load = vi.fn(() => (++call === 1 ? first.promise : second.promise));
  const refresh = singleFlight(load);

  const request = refresh();
  expect(refresh()).toBe(request);

  first.reject(new Error("offline"));
  await expect(request).rejects.toThrow("offline");

  const retry = refresh();
  expect(load).toHaveBeenCalledTimes(2);

  second.resolve("recovered");
  await expect(retry).resolves.toBe("recovered");
});

function stubVisibility() {
  const events = new EventTarget();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: events.addEventListener.bind(events),
  };
  vi.stubGlobal("document", doc);
  return (state: DocumentVisibilityState) => {
    doc.visibilityState = state;
    events.dispatchEvent(new Event("visibilitychange"));
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("refreshes every interval while visible and restarts the interval on a manual refresh", () => {
  vi.useFakeTimers();
  stubVisibility();
  const refresh = vi.fn();
  const refreshNow = scheduleRefresh(refresh, 60_000);

  vi.advanceTimersByTime(60_000);
  expect(refresh).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(30_000);
  refreshNow();
  expect(refresh).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(59_999);
  expect(refresh).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(1);
});

it("pauses while hidden and refreshes on return only once the interval has passed", () => {
  vi.useFakeTimers();
  const setVisibility = stubVisibility();
  const refresh = vi.fn();
  scheduleRefresh(refresh, 60_000);

  setVisibility("hidden");
  vi.advanceTimersByTime(30_000);
  setVisibility("visible");
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(29_999);
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(1);

  setVisibility("hidden");
  vi.advanceTimersByTime(5 * 60_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  setVisibility("visible");
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
});
