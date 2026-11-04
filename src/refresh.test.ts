import { expect, it, vi } from "vite-plus/test";
import { keyedSingleFlight, singleFlight } from "./refresh.ts";

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

it("deduplicates by key and releases each key independently", async () => {
  const requests = new Map<string, Deferred<string>>();
  const load = vi.fn((key: string) => {
    const request = deferred<string>();
    requests.set(key, request);
    return request.promise;
  });
  const refresh = keyedSingleFlight(load);

  const first = refresh("a");
  expect(refresh("a")).toBe(first);
  const other = refresh("b");
  expect(load).toHaveBeenCalledTimes(2);

  requests.get("a")!.resolve("A");
  await expect(first).resolves.toBe("A");
  expect(requests.get("b")?.promise).toBe(other);

  const retried = refresh("a");
  expect(retried).not.toBe(first);
  expect(load).toHaveBeenCalledTimes(3);

  requests.get("b")!.resolve("B");
  await expect(other).resolves.toBe("B");
  requests.get("a")!.resolve("A2");
  await expect(retried).resolves.toBe("A2");
});

it("releases a key after its request rejects", async () => {
  const requests: Deferred<string>[] = [];
  const load = vi.fn(() => {
    const request = deferred<string>();
    requests.push(request);
    return request.promise;
  });
  const refresh = keyedSingleFlight(load);

  const first = refresh("x");
  requests[0].reject(new Error("offline"));
  await expect(first).rejects.toThrow("offline");

  const retry = refresh("x");
  expect(load).toHaveBeenCalledTimes(2);

  requests[1].resolve("ok");
  await expect(retry).resolves.toBe("ok");
});
