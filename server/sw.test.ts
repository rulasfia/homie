import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const ORIGIN = "https://homie.test";
const CACHE_NAME = "homie-__HOMIE_CACHE_VERSION__";
const OFFLINE_URL = `${ORIGIN}/offline.html`;

type RequestInput = string | { url: string };
type FetchEventRequest = {
  url: string;
  method: string;
  mode: string;
};

type CacheLike = {
  addAll(urls: string[]): Promise<void>;
  match(request: RequestInput): Promise<Response | undefined>;
  put(request: RequestInput, response: Response): Promise<void>;
};

function cacheKey(input: RequestInput): string {
  return new URL(typeof input === "string" ? input : input.url, ORIGIN).href;
}

function request(path: string, init: Partial<Omit<FetchEventRequest, "url">> = {}) {
  return {
    url: path.startsWith("http") ? path : `${ORIGIN}${path}`,
    method: init.method ?? "GET",
    mode: init.mode ?? "no-cors",
  };
}

class FakeEvent {
  readonly request: FetchEventRequest;
  readonly waited: Promise<unknown>[] = [];
  response: Promise<Response> | undefined;
  private dispatching = true;

  constructor(request: FetchEventRequest) {
    this.request = request;
  }

  waitUntil(promise: Promise<unknown>) {
    if (!this.dispatching && this.waited.length === 0) {
      throw new Error("waitUntil must first be called during dispatch");
    }
    this.waited.push(promise);
  }

  endDispatch() {
    this.dispatching = false;
  }

  respondWith(promise: Promise<Response>) {
    this.response = Promise.resolve(promise);
  }
}

function createHarness() {
  const stores = new Map<string, Map<string, Response>>();
  const listeners = new Map<string, (event: FakeEvent) => void>();
  const puts: string[] = [];
  const matches: string[] = [];

  function entriesFor(name: string) {
    let entries = stores.get(name);
    if (!entries) {
      entries = new Map();
      stores.set(name, entries);
    }
    return entries;
  }

  const fetchMock = vi.fn(async (input: RequestInput): Promise<Response> => {
    throw new Error(`unexpected fetch: ${cacheKey(input)}`);
  });

  function createCache(name: string): CacheLike {
    const entries = entriesFor(name);
    return {
      async addAll(urls) {
        for (const url of urls) {
          const response = await fetchMock(url);
          if (!response.ok) throw new Error(`failed to cache ${url}`);
          entries.set(cacheKey(url), response.clone());
        }
      },
      async match(input) {
        const key = cacheKey(input);
        matches.push(`${name}:${key}`);
        return entries.get(key);
      },
      async put(input, response) {
        const key = cacheKey(input);
        puts.push(`${name}:${key}`);
        entries.set(key, response);
      },
    };
  }

  const caches = {
    open: vi.fn(async (name: string) => createCache(name)),
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  };

  const skipWaiting = vi.fn(async () => {});
  const claim = vi.fn(async () => {});
  const self = {
    location: { origin: ORIGIN },
    addEventListener: vi.fn((type: string, listener: (event: FakeEvent) => void) => {
      listeners.set(type, listener);
    }),
    skipWaiting,
    clients: { claim },
  };

  runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
    self,
    caches,
    fetch: fetchMock,
    Response,
    URL,
  });

  function seed(name: string, path: string, response: Response) {
    entriesFor(name).set(cacheKey(path), response);
  }

  async function dispatchLifecycle(type: "install" | "activate") {
    const event = new FakeEvent(request("/"));
    const listener = listeners.get(type);
    if (!listener) throw new Error(`${type} listener was not registered`);
    listener(event);
    event.endDispatch();
    await Promise.all(event.waited);
  }

  function startFetch(input: FetchEventRequest) {
    const event = new FakeEvent(input);
    const listener = listeners.get("fetch");
    if (!listener) throw new Error("fetch listener was not registered");
    listener(event);
    event.endDispatch();
    return event;
  }

  async function dispatchFetch(input: FetchEventRequest) {
    const event = startFetch(input);
    const response = event.response ? await event.response : undefined;
    await Promise.all(event.waited);
    return { event, handled: event.response !== undefined, response };
  }

  return {
    caches,
    fetchMock,
    puts,
    matches,
    skipWaiting,
    claim,
    seed,
    entries: entriesFor,
    install: () => dispatchLifecycle("install"),
    activate: () => dispatchLifecycle("activate"),
    startFetch,
    dispatchFetch,
  };
}

let harness: ReturnType<typeof createHarness>;

beforeEach(() => {
  harness = createHarness();
  harness.fetchMock.mockImplementation(async (input) => new Response(cacheKey(input)));
});

it("installs the offline page, icons, and versioned cache", async () => {
  await harness.install();

  expect(harness.caches.open).toHaveBeenCalledWith(CACHE_NAME);
  const entries = harness.entries(CACHE_NAME);
  expect(entries.has(OFFLINE_URL)).toBe(true);
  expect(entries.has(`${ORIGIN}/icons/icon-192x192.png`)).toBe(true);
  expect(entries.has(`${ORIGIN}/icons/icon-512x512.png`)).toBe(true);
  expect(entries.has(`${ORIGIN}/icons/apple-touch-icon.png`)).toBe(true);
  expect(harness.skipWaiting).toHaveBeenCalled();
});

it("activation removes only obsolete Homie caches", async () => {
  harness.seed(CACHE_NAME, "/index.html", new Response("current"));
  harness.seed("homie-v1", "/index.html", new Response("old"));
  harness.seed("other-app-v3", "/index.html", new Response("other"));

  await harness.activate();

  expect(harness.caches.delete).toHaveBeenCalledTimes(1);
  expect(harness.caches.delete).toHaveBeenCalledWith("homie-v1");
  expect(harness.entries(CACHE_NAME).has(`${ORIGIN}/index.html`)).toBe(true);
  expect(harness.entries("other-app-v3").has(`${ORIGIN}/index.html`)).toBe(true);
  expect(harness.claim).toHaveBeenCalled();
});

it("online navigation always returns the current network shell", async () => {
  harness.seed(CACHE_NAME, "/index.html", new Response("stale shell"));
  harness.fetchMock.mockResolvedValueOnce(new Response("fresh shell"));

  const { handled, response } = await harness.dispatchFetch(request("/", { mode: "navigate" }));

  expect(handled).toBe(true);
  expect(await response?.text()).toBe("fresh shell");
  expect(harness.puts).toEqual([]);
  expect(harness.matches.some((entry) => entry.endsWith("/index.html"))).toBe(false);
});

it("offline navigation returns the reconnect page instead of a stale shell", async () => {
  harness.seed(CACHE_NAME, "/index.html", new Response("stale shell"));
  harness.seed(CACHE_NAME, "/offline.html", new Response("reconnect page"));
  harness.fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

  const { handled, response } = await harness.dispatchFetch(request("/", { mode: "navigate" }));

  expect(handled).toBe(true);
  expect(await response?.text()).toBe("reconnect page");
  expect(harness.matches).toContain(`${CACHE_NAME}:${OFFLINE_URL}`);
});

it("offline navigation still answers when the offline page is not cached", async () => {
  harness.seed(CACHE_NAME, "/index.html", new Response("stale shell"));
  harness.fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

  const { response } = await harness.dispatchFetch(request("/", { mode: "navigate" }));

  expect(response?.status).toBe(200);
  expect(response?.headers.get("content-type")).toContain("text/html");
  const body = await response?.text();
  expect(body).toContain("offline");
  expect(body).not.toContain("stale shell");
});

it("API failures return 503 without reading cached config or health data", async () => {
  harness.seed(CACHE_NAME, "/api/config", new Response('{"private":"secret"}'));
  harness.seed(CACHE_NAME, "/api/systems", new Response('{"status":"green"}'));
  harness.fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

  const { handled, response } = await harness.dispatchFetch(request("/api/config"));

  expect(handled).toBe(true);
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({ error: "offline" });
  expect(harness.matches).toEqual([]);
});

it("API responses are never written to the cache", async () => {
  harness.fetchMock.mockResolvedValueOnce(new Response('{"title":"homie"}'));

  const { response } = await harness.dispatchFetch(request("/api/config"));

  expect(await response?.json()).toEqual({ title: "homie" });
  expect(harness.puts).toEqual([]);
});

it("caches allowed static assets in the current cache and extends the event", async () => {
  harness.fetchMock.mockResolvedValueOnce(new Response("bundle"));

  const { event, response } = await harness.dispatchFetch(request("/assets/index-abc123.js"));

  expect(await response?.text()).toBe("bundle");
  expect(event.waited).toHaveLength(1);
  expect(harness.puts).toContain(`${CACHE_NAME}:${ORIGIN}/assets/index-abc123.js`);
  expect(await harness.entries(CACHE_NAME).get(`${ORIGIN}/assets/index-abc123.js`)?.text()).toBe(
    "bundle",
  );
});

it("serves an online asset even when the cache write fails", async () => {
  harness.caches.open.mockImplementation(async () => ({
    addAll: async () => {},
    match: async () => undefined,
    put: async () => {
      throw new Error("quota exceeded");
    },
  }));
  harness.fetchMock.mockResolvedValueOnce(new Response("bundle"));

  const { event, response } = await harness.dispatchFetch(request("/assets/index-abc123.js"));

  expect(await response?.text()).toBe("bundle");
  expect(event.waited).toHaveLength(1);
});

it("keeps a pending cache write alive without delaying the asset response", async () => {
  let finishWrite!: () => void;
  const write = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  harness.caches.open.mockImplementation(async () => ({
    addAll: async () => {},
    match: async () => undefined,
    put: () => write,
  }));
  harness.fetchMock.mockResolvedValueOnce(new Response("bundle"));

  const event = harness.startFetch(request("/assets/index-abc123.js"));
  expect(event.waited).toHaveLength(1);
  const response = await event.response;
  expect(await response?.text()).toBe("bundle");

  let settled = false;
  const lifetime = Promise.all(event.waited).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  finishWrite();
  await lifetime;
  expect(settled).toBe(true);
});

it("serves an online asset when cache storage is unavailable", async () => {
  harness.caches.open.mockRejectedValueOnce(new Error("cache unavailable"));
  harness.fetchMock.mockResolvedValueOnce(new Response("bundle"));

  const { response } = await harness.dispatchFetch(request("/assets/index-abc123.js"));

  expect(await response?.text()).toBe("bundle");
});

it("ignores non-GET, cross-origin, and unflagged same-origin requests", async () => {
  const nonGet = await harness.dispatchFetch(request("/api/config", { method: "POST" }));
  const crossOrigin = await harness.dispatchFetch(request("https://other.test/assets/app.js"));
  const unflagged = await harness.dispatchFetch(request("/notes.txt"));

  expect(nonGet.handled).toBe(false);
  expect(crossOrigin.handled).toBe(false);
  expect(unflagged.handled).toBe(false);
  expect(harness.fetchMock).not.toHaveBeenCalled();
});

it("does not cache arbitrary same-origin paths or failed asset responses", async () => {
  harness.fetchMock.mockImplementation(async (input) => {
    const url = cacheKey(input);
    if (url.endsWith("/assets/missing.js")) return new Response("missing", { status: 404 });
    return new Response("asset");
  });

  const allowed = await harness.dispatchFetch(request("/icons/icon-72x72.png"));
  const missing = await harness.dispatchFetch(request("/assets/missing.js"));
  const arbitrary = await harness.dispatchFetch(request("/random-file.js"));

  expect(allowed.handled).toBe(true);
  expect(missing.handled).toBe(true);
  expect(arbitrary.handled).toBe(false);
  expect(harness.puts).toEqual([`${CACHE_NAME}:${ORIGIN}/icons/icon-72x72.png`]);
});
