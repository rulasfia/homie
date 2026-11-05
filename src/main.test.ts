import { afterEach, expect, it, vi } from "vite-plus/test";

// Theme stylesheets are empty here, so a first import does not race the flushes below.
vi.mock("./styles/themes/aqua.css", () => ({}));
vi.mock("./styles/themes/metal.css", () => ({}));

class FakeElement {
  hidden = false;
  innerHTML = "";
  textContent = "";
  className = "";
  title = "";
  disabled = false;
  value = "";
  dataset: Record<string, string> = {};
  onchange: ((event: Event) => void) | null = null;
  children = new Map<string, FakeElement>();
  private listeners = new Map<string, Array<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }

  querySelector(selector: string) {
    return this.children.get(selector) ?? null;
  }

  setAttribute() {}
}

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** An `/api/pings` response with one NDJSON line per result. */
function ndjson(results: unknown[]) {
  return new Response(results.map((result) => `${JSON.stringify(result)}\n`).join(""));
}

type ApiHandler = () => unknown;

function mockApi(
  handlers: { systems?: ApiHandler; containers?: ApiHandler; pings?: () => Response } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/config") return json({ title: "Homie", groups: [] });
      if (url === "/api/systems") {
        return json(handlers.systems?.() ?? { configured: false, systems: [] });
      }
      if (url === "/api/containers/all") {
        return json(handlers.containers?.() ?? { configured: false, sources: [], containers: [] });
      }
      if (url === "/api/pings") return handlers.pings?.() ?? ndjson([]);
      throw new Error(`unexpected request: ${url}`);
    }),
  );
}

function stubRefreshFetch(handlers: {
  systems: () => Promise<Response>;
  containers: () => Promise<Response>;
  pings?: () => Promise<Response>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/config") {
        return Promise.resolve(json({ title: "Homie", groups: [] }));
      }
      if (url === "/api/systems") return handlers.systems();
      if (url === "/api/containers/all") return handlers.containers();
      if (url === "/api/pings") return handlers.pings?.() ?? Promise.resolve(ndjson([]));
      throw new Error(`unexpected request: ${url}`);
    }),
  );
}

function stubDom(pings: FakeElement[] = []) {
  const elements = new Map<string, FakeElement>([
    ["#systems", new FakeElement()],
    ["#systems-grid", new FakeElement()],
    ["#systems-status", new FakeElement()],
    ["#containers", new FakeElement()],
    ["#containers-table", new FakeElement()],
    ["#containers-status", new FakeElement()],
    ["#containers-content", new FakeElement()],
    ["#container-machine-filter", new FakeElement()],
    ["#feeds", new FakeElement()],
    ["#feeds-list", new FakeElement()],
    ["#feeds-status", new FakeElement()],
    ["#weather", new FakeElement()],
    ["#weather-location", new FakeElement()],
    ["#weather-body", new FakeElement()],
  ]);
  const theme = new FakeElement();
  const refresh = new FakeElement();
  const app = Object.assign(new FakeElement(), {
    querySelector: (selector: string) =>
      selector === ".app-theme" ? theme : selector === ".app-refresh" ? refresh : null,
  });

  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();

  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("window", windowEvents);
  vi.stubGlobal("document", {
    title: "",
    visibilityState: "visible",
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    dispatchEvent: documentEvents.dispatchEvent.bind(documentEvents),
    documentElement: { dataset: {} },
    querySelector: (selector: string) =>
      selector === "#app" ? app : (elements.get(selector) ?? null),
    querySelectorAll: (selector: string) => (selector === "[data-ping-url]" ? pings : []),
  });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: false }));
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  return { elements, refresh, app };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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

function pingTile(url: string) {
  const ping = new FakeElement();
  ping.dataset.pingUrl = url;
  const dot = new FakeElement();
  const latency = new FakeElement();
  ping.children.set(".status-dot", dot);
  ping.children.set(".ping-latency", latency);
  return { ping, dot, latency };
}

function system(name: string) {
  return {
    id: name,
    name,
    host: name,
    status: "up",
    uptime: 3600,
    cpu: 10,
    memPct: 20,
    diskPct: 30,
    agentVersion: "1.0.0",
  };
}

const localContainer = {
  id: "0123456789ab",
  name: "homie",
  image: "homie:latest",
  state: "running",
  status: "Up 1 hour",
  ports: ["3000:3000"],
  source: "local",
  systemName: "local",
};

const remoteContainer = {
  name: "jellyfin",
  state: "running",
  source: "remote",
  systemId: "nas",
  systemName: "nas",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("hides both monitoring sections when they are not configured", async () => {
  const { elements } = stubDom();
  mockApi();

  await import("./main.ts");
  await flush();

  expect(elements.get("#systems")?.hidden).toBe(true);
  expect(elements.get("#containers")?.hidden).toBe(true);
});

it("shows explicit loading copy before monitoring data arrives", async () => {
  const { app } = stubDom();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/config") return Promise.resolve(json({ title: "Homie", groups: [] }));
      return new Promise<Response>(() => {});
    }),
  );

  await import("./main.ts");
  await flush();

  expect(app.innerHTML).toContain("Loading machines…");
  expect(app.innerHTML).toContain("Loading containers…");
});

it("keeps a configured empty machines section visible with an empty state", async () => {
  const { elements } = stubDom();
  mockApi({ systems: () => ({ configured: true, systems: [] }) });

  await import("./main.ts");
  await flush();

  expect(elements.get("#systems")?.hidden).toBe(false);
  expect(elements.get("#systems-status")?.innerHTML).toMatch(/no machines/i);
});

it("shows machines unavailable when the first load fails", async () => {
  const { elements } = stubDom();
  mockApi({
    systems: () => {
      throw new Error("offline");
    },
  });

  await import("./main.ts");
  await flush();

  expect(elements.get("#systems")?.hidden).toBe(false);
  expect(elements.get("#systems-status")?.innerHTML).toMatch(/unavailable/i);
});

it("retains machines with a stale warning on refresh failure, then clears it on recovery", async () => {
  const { elements, refresh } = stubDom();
  let fail = false;
  mockApi({
    systems: () => {
      if (fail) throw new Error("offline");
      return { configured: true, systems: [system("nas")] };
    },
  });

  await import("./main.ts");
  await flush();
  expect(elements.get("#systems-grid")?.innerHTML).toContain("nas");

  fail = true;
  refresh.dispatch("click");
  await flush();
  expect(elements.get("#systems-grid")?.innerHTML).toContain("nas");
  expect(elements.get("#systems-status")?.innerHTML).toMatch(/refresh failed.*last update/i);

  fail = false;
  refresh.dispatch("click");
  await flush();
  expect(elements.get("#systems-status")?.hidden).toBe(true);
});

it("keeps a configured empty containers section visible with an empty state", async () => {
  const { elements } = stubDom();
  mockApi({
    containers: () => ({
      configured: true,
      sources: [{ id: "local", name: "homie" }],
      containers: [],
    }),
  });

  await import("./main.ts");
  await flush();

  expect(elements.get("#containers")?.hidden).toBe(false);
  expect(elements.get("#containers-table")?.innerHTML).toMatch(/no containers/i);
});

it("renders remote memory as an amount and network as rates in the table", async () => {
  const { elements } = stubDom();
  mockApi({
    containers: () => ({
      configured: true,
      sources: [{ id: "nas", name: "nas" }],
      containers: [
        {
          ...remoteContainer,
          cpuPct: 12.5,
          memBytes: 512 * 1024 ** 2,
          netSentBps: 1536,
          netRecvBps: 2048,
        },
      ],
    }),
  });
  await import("./main.ts");
  await flush();
  expect(elements.get("#containers-table")?.innerHTML).toContain(
    "cpu 13% · mem 512 MiB · net ↑ 1.5 KiB/s ↓ 2 KiB/s",
  );
});

it("shows containers unavailable when the first load fails", async () => {
  const { elements } = stubDom();
  mockApi({
    containers: () => {
      throw new Error("offline");
    },
  });

  await import("./main.ts");
  await flush();

  expect(elements.get("#containers")?.hidden).toBe(false);
  expect(elements.get("#containers-status")?.innerHTML).toMatch(/unavailable/i);
});

it("keeps healthy containers and names failed sources on a partial response", async () => {
  const { elements, refresh } = stubDom();
  let partial = true;
  mockApi({
    containers: () =>
      partial
        ? {
            configured: true,
            sources: [
              { id: "local", name: "homie" },
              { id: "nas", name: "nas", error: "container stats unavailable" },
            ],
            containers: [localContainer],
            partial: true,
          }
        : {
            configured: true,
            sources: [
              { id: "local", name: "homie" },
              { id: "nas", name: "nas" },
            ],
            containers: [localContainer, remoteContainer],
          },
  });

  await import("./main.ts");
  await flush();

  expect(elements.get("#containers-table")?.innerHTML).toContain("homie");
  expect(elements.get("#containers-status")?.innerHTML).toContain(
    "nas (container stats unavailable)",
  );

  partial = false;
  refresh.dispatch("click");
  await flush();
  expect(elements.get("#containers-status")?.hidden).toBe(true);
});

it("retains containers and warns when a refresh fails", async () => {
  const { elements, refresh } = stubDom();
  let fail = false;
  mockApi({
    containers: () => {
      if (fail) throw new Error("offline");
      return {
        configured: true,
        sources: [{ id: "local", name: "homie" }],
        containers: [localContainer],
      };
    },
  });

  await import("./main.ts");
  await flush();
  fail = true;
  refresh.dispatch("click");
  await flush();

  expect(elements.get("#containers-table")?.innerHTML).toContain("homie");
  expect(elements.get("#containers-status")?.innerHTML).toMatch(/refresh failed.*last update/i);

  refresh.dispatch("click");
  await flush();
  const warning = elements.get("#containers-status")?.innerHTML ?? "";
  expect(warning.match(/refresh failed/gi)).toHaveLength(1);
});

it("groups containers per machine with a running count", async () => {
  const { elements } = stubDom();
  mockApi({
    containers: () => ({
      configured: true,
      sources: [
        { id: "local", name: "homie" },
        { id: "nas", name: "nas" },
      ],
      containers: [
        remoteContainer,
        localContainer,
        { ...remoteContainer, name: "navidrome", state: "exited" },
      ],
    }),
  });

  await import("./main.ts");
  await flush();

  const groups = (elements.get("#containers-table")?.innerHTML ?? "").split("<tbody>").slice(1);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toMatch(/nas\s*<span class="container-group-count">1\/2 running/);
  expect(groups[0]).toContain("jellyfin");
  expect(groups[0]).toContain("navidrome");
  expect(groups[1]).toMatch(/local\s*<span class="container-group-count">1\/1 running/);
});

it("keeps the machine filter working across container refreshes", async () => {
  const { elements, refresh } = stubDom();
  mockApi({
    containers: () => ({
      configured: true,
      sources: [
        { id: "local", name: "homie" },
        { id: "nas", name: "nas" },
      ],
      containers: [localContainer, remoteContainer],
    }),
  });

  await import("./main.ts");
  await flush();

  const select = elements.get("#container-machine-filter")!;
  expect(select.disabled).toBe(false);
  select.value = "nas";
  select.onchange?.({ target: select } as unknown as Event);
  expect(elements.get("#containers-table")?.innerHTML).toContain("jellyfin");
  expect(elements.get("#containers-table")?.innerHTML).not.toContain("homie");

  refresh.dispatch("click");
  await flush();
  expect(select.value).toBe("nas");
  expect(elements.get("#containers-table")?.innerHTML).toContain("jellyfin");
  expect(elements.get("#containers-table")?.innerHTML).not.toContain("homie");
});

it("coalesces overlapping machine refreshes and loads again after the first finishes", async () => {
  const { elements, refresh } = stubDom();
  const systemsRequests: Deferred<Response>[] = [];
  stubRefreshFetch({
    systems: () => {
      const request = deferred<Response>();
      systemsRequests.push(request);
      return request.promise;
    },
    containers: () => Promise.resolve(json({ configured: false, sources: [], containers: [] })),
  });

  await import("./main.ts");
  await flush();
  expect(systemsRequests).toHaveLength(1);

  refresh.dispatch("click");
  refresh.dispatch("click");
  await flush();
  expect(systemsRequests).toHaveLength(1);

  systemsRequests[0].resolve(json({ configured: true, systems: [system("nas")] }));
  await flush();
  expect(elements.get("#systems-grid")?.innerHTML).toContain("nas");

  refresh.dispatch("click");
  await flush();
  expect(systemsRequests).toHaveLength(2);

  systemsRequests[1].resolve(json({ configured: true, systems: [system("nas"), system("pi")] }));
  await flush();
  expect(elements.get("#systems-grid")?.innerHTML).toContain("pi");
});

it("releases the machine guard after a failed refresh and retries", async () => {
  const { elements, refresh } = stubDom();
  const systemsRequests: Deferred<Response>[] = [];
  stubRefreshFetch({
    systems: () => {
      const request = deferred<Response>();
      systemsRequests.push(request);
      return request.promise;
    },
    containers: () => Promise.resolve(json({ configured: false, sources: [], containers: [] })),
  });

  await import("./main.ts");
  await flush();
  expect(systemsRequests).toHaveLength(1);

  systemsRequests[0].reject(new Error("offline"));
  await flush();
  expect(elements.get("#systems-status")?.innerHTML).toMatch(/unavailable/i);

  refresh.dispatch("click");
  await flush();
  expect(systemsRequests).toHaveLength(2);

  systemsRequests[1].resolve(json({ configured: true, systems: [system("nas")] }));
  await flush();
  expect(elements.get("#systems-grid")?.innerHTML).toContain("nas");
});

it("updates machines and containers independently as each request completes", async () => {
  const { elements } = stubDom();
  const systemsRequest = deferred<Response>();
  const containersRequest = deferred<Response>();
  stubRefreshFetch({
    systems: () => systemsRequest.promise,
    containers: () => containersRequest.promise,
  });

  await import("./main.ts");
  await flush();

  systemsRequest.resolve(json({ configured: true, systems: [system("nas")] }));
  await flush();
  expect(elements.get("#systems-grid")?.innerHTML).toContain("nas");
  expect(elements.get("#containers-table")?.innerHTML).not.toContain("homie");

  containersRequest.resolve(
    json({
      configured: true,
      sources: [{ id: "local", name: "homie" }],
      containers: [localContainer],
    }),
  );
  await flush();
  expect(elements.get("#containers-table")?.innerHTML).toContain("homie");
});

it("applies streamed ping results split mid-line to every matching tile", async () => {
  const first = pingTile("https://example.com");
  const duplicate = pingTile("https://example.com");
  const other = pingTile("https://other.example");
  const missing = pingTile("https://missing.example");
  const { refresh } = stubDom([first.ping, duplicate.ping, other.ping, missing.ping]);
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  stubRefreshFetch({
    systems: () => Promise.resolve(json({ configured: false, systems: [] })),
    containers: () => Promise.resolve(json({ configured: false, sources: [], containers: [] })),
    pings: async () =>
      new Response(
        new ReadableStream<Uint8Array>({ start: (stream) => void streams.push(stream) }),
      ),
  });
  const bytes = new TextEncoder().encode(
    [
      { url: "https://example.com", ok: true, status: 200, latencyMs: 12 },
      { url: "https://other.example", ok: false, status: 503, latencyMs: 5 },
    ]
      .map((result) => `${JSON.stringify(result)}\n`)
      .join(""),
  );
  const firstLineEnd = bytes.indexOf("\n".charCodeAt(0)) + 1;

  await import("./main.ts");
  await flush();
  expect(streams).toHaveLength(1);

  streams[0].enqueue(bytes.slice(0, 20));
  await flush();
  expect(first.dot.dataset.status).toBe("pending");

  streams[0].enqueue(bytes.slice(20, firstLineEnd + 20));
  await flush();
  for (const tile of [first, duplicate]) {
    expect(tile.dot.dataset.status).toBe("up");
    expect(tile.latency.hidden).toBe(false);
    expect(tile.latency.textContent).toBe("12ms");
  }
  expect(other.dot.dataset.status).toBe("pending");

  // A refresh mid-stream joins it and keeps the results already received.
  refresh.dispatch("click");
  await flush();
  expect(streams).toHaveLength(1);
  expect(first.dot.dataset.status).toBe("up");
  expect(other.dot.dataset.status).toBe("pending");

  streams[0].enqueue(bytes.slice(firstLineEnd + 20));
  streams[0].close();
  await flush();
  expect(other.dot.dataset.status).toBe("down");
  expect(other.latency.textContent).toBe("5ms");
  expect(missing.dot.dataset.status).toBe("down");
  expect(missing.dot.title).toBe("ping request failed");

  refresh.dispatch("click");
  await flush();
  expect(streams).toHaveLength(2);
});

it("hides the previous ping latency when the next request fails", async () => {
  const ping = new FakeElement();
  ping.dataset.pingUrl = "https://example.com";
  const dot = new FakeElement();
  const latency = new FakeElement();
  ping.children.set(".status-dot", dot);
  ping.children.set(".ping-latency", latency);

  const { refresh } = stubDom([ping]);
  let fail = false;
  mockApi({
    pings: () => {
      if (fail) throw new Error("offline");
      return ndjson([{ url: "https://example.com", ok: true, status: 200, latencyMs: 12 }]);
    },
  });

  await import("./main.ts");
  await flush();
  expect(latency.hidden).toBe(false);
  expect(latency.textContent).toBe("12ms");

  fail = true;
  refresh.dispatch("click");
  await flush();
  expect(latency.hidden).toBe(true);
  expect(latency.textContent).toBe("");
});

/** Config that fails like the server or the offline service worker would. */
function failingConfig(message?: string) {
  return {
    ok: false,
    status: 503,
    json: async () => (message ? { error: message } : Promise.reject(new Error("not json"))),
  } as Response;
}

it("retries a failed config load with backoff and sets up once on success", async () => {
  vi.useFakeTimers();
  try {
    const { app, refresh } = stubDom();
    const retryButton = new FakeElement();
    const appQuery = app.querySelector;
    app.querySelector = (selector: string) =>
      selector === ".app-retry" ? retryButton : appQuery(selector);
    let configRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/config") {
          configRequests++;
          return configRequests < 3
            ? failingConfig("config <b>invalid</b>")
            : json({ title: "Homie", groups: [] });
        }
        if (url === "/api/systems") return json({ configured: false, systems: [] });
        if (url === "/api/containers/all") {
          return json({ configured: false, sources: [], containers: [] });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const refreshListeners = vi.spyOn(refresh, "addEventListener");

    await import("./main.ts");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.innerHTML).toContain("failed to load config");
    expect(app.innerHTML).toContain("config &lt;b&gt;invalid&lt;/b&gt;");
    expect(app.innerHTML).toContain("retrying in 2s");
    expect(app.innerHTML).toContain("retry</button>");

    await vi.advanceTimersByTimeAsync(1_999);
    expect(configRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(configRequests).toBe(2);
    expect(app.innerHTML).toContain("retrying in 4s");

    await vi.advanceTimersByTimeAsync(4_000);
    expect(configRequests).toBe(3);
    expect(document.title).toBe("Homie");
    expect(app.innerHTML).not.toContain("failed to load config");
    expect(refreshListeners).toHaveBeenCalledTimes(1);

    // Nothing is left behind: no retry timer, no online/visibility listeners.
    // (The 60s refresh re-fetches the config, so stop just before it.)
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(configRequests).toBe(3);
    expect(refreshListeners).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("shares one config load between the timer, online and the retry button", async () => {
  vi.useFakeTimers();
  try {
    const { app, refresh } = stubDom();
    const retryButton = new FakeElement();
    const appQuery = app.querySelector;
    app.querySelector = (selector: string) =>
      selector === ".app-retry" ? retryButton : appQuery(selector);
    const pending = deferred<Response>();
    let configRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/config") {
          configRequests++;
          return configRequests === 1 ? Promise.resolve(failingConfig()) : pending.promise;
        }
        if (url === "/api/systems")
          return Promise.resolve(json({ configured: false, systems: [] }));
        if (url === "/api/containers/all") {
          return Promise.resolve(json({ configured: false, sources: [], containers: [] }));
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const refreshListeners = vi.spyOn(refresh, "addEventListener");

    await import("./main.ts");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.innerHTML).toContain("failed to load config: 503");

    // The backoff timer fires and the second load stays in flight...
    await vi.advanceTimersByTimeAsync(2_000);
    expect(configRequests).toBe(2);
    // ...while online, visibility and the button all fire at the same moment.
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    retryButton.dispatch("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(configRequests).toBe(2);

    pending.resolve(json({ title: "Homie", groups: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshListeners).toHaveBeenCalledTimes(1);
    expect(app.innerHTML).not.toContain("failed to load config");
  } finally {
    vi.useRealTimers();
  }
});

it("doubles the retry delay and caps it at 60s", async () => {
  vi.useFakeTimers();
  try {
    const { app } = stubDom();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failingConfig("down")),
    );

    await import("./main.ts");
    await vi.advanceTimersByTimeAsync(0);

    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const seconds = Number(/retrying in (\d+)s/.exec(app.innerHTML)?.[1]);
      delays.push(seconds);
      await vi.advanceTimersByTimeAsync(seconds * 1000);
    }
    expect(delays).toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
  } finally {
    vi.useRealTimers();
  }
});

function bookmarksConfig(...urls: string[]) {
  return {
    title: "Homie",
    groups: [{ name: "apps", bookmarks: urls.map((url) => ({ name: url, url, ping: true })) }],
  };
}

/**
 * Stubs the Services section so replacing its outerHTML swaps the ping tiles
 * that `[data-ping-url]` returns, like a real re-render would.
 */
function stubServices(elements: Map<string, FakeElement>, pings: FakeElement[]) {
  const writes: string[] = [];
  const services = new FakeElement();
  Object.defineProperty(services, "outerHTML", {
    set(html: string) {
      writes.push(html);
      const urls = [...html.matchAll(/data-ping-url="([^"]+)"/g)].map((match) => match[1]);
      pings.splice(0, pings.length, ...urls.map((url) => pingTile(url).ping));
    },
  });
  elements.set("[data-services]", services);
  elements.set(".app-title", new FakeElement());
  return writes;
}

/** Serves `config()` and answers `/api/pings` for the last config served, like the server would. */
function stubConfigFetch(config: () => ReturnType<typeof bookmarksConfig>) {
  const pinged: string[] = [];
  let served = { groups: [] } as Pick<ReturnType<typeof bookmarksConfig>, "groups">;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/config") {
        served = config();
        return json(served);
      }
      if (url === "/api/systems") return json({ configured: false, systems: [] });
      if (url === "/api/containers/all") {
        return json({ configured: false, sources: [], containers: [] });
      }
      if (url === "/api/pings") {
        const urls = served.groups.flatMap((group) => group.bookmarks.map((b) => b.url));
        pinged.push(...urls);
        return ndjson(urls.map((url) => ({ url, ok: true, status: 200, latencyMs: 1 })));
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
  return pinged;
}

it("applies a config change on refresh in place and keeps hidden sections", async () => {
  const pings = [pingTile("https://a.example").ping];
  const { app, elements, refresh } = stubDom(pings);
  vi.stubGlobal("localStorage", { getItem: () => '["services"]', setItem: () => {} });
  const writes = stubServices(elements, pings);
  let config = bookmarksConfig("https://a.example");
  const pinged = stubConfigFetch(() => config);

  await import("./main.ts");
  await flush();
  const page = app.innerHTML;

  config = { ...bookmarksConfig("https://b.example"), title: "Lab" };
  pinged.length = 0;
  refresh.dispatch("click");
  await flush();

  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain('data-ping-url="https://b.example"');
  expect(writes[0]).not.toContain("https://a.example");
  expect(writes[0]).toContain("section-hidden");
  expect(writes[0]).toContain('aria-expanded="false"');
  expect(pinged).toEqual(["https://b.example"]);
  expect(document.title).toBe("Lab");
  expect(elements.get(".app-title")?.textContent).toBe("Lab");
  expect(app.innerHTML).toBe(page);

  config = { title: "Lab", groups: [] };
  refresh.dispatch("click");
  await flush();
  expect(writes[1]).toContain("no bookmarks configured");
  expect(writes[1]).toContain("data-services");
});

it("does not re-render when the config is unchanged", async () => {
  const pings = [pingTile("https://a.example").ping];
  const { elements, refresh } = stubDom(pings);
  const writes = stubServices(elements, pings);
  const pinged = stubConfigFetch(() => bookmarksConfig("https://a.example"));

  await import("./main.ts");
  await flush();
  refresh.dispatch("click");
  await flush();

  expect(writes).toHaveLength(0);
  expect(pinged).toEqual(["https://a.example", "https://a.example"]);
});

it("keeps the page and still refreshes everything when the config re-fetch fails", async () => {
  const pings = [pingTile("https://a.example").ping];
  const { app, elements, refresh } = stubDom(pings);
  const writes = stubServices(elements, pings);
  let configFails = false;
  const pinged = stubConfigFetch(() => {
    if (configFails) throw new Error("offline");
    return bookmarksConfig("https://a.example");
  });

  await import("./main.ts");
  await flush();
  const page = app.innerHTML;
  const requests = vi.mocked(fetch).mock.calls.map(([url]) => url);
  expect(requests.filter((url) => url === "/api/systems")).toHaveLength(1);

  configFails = true;
  refresh.dispatch("click");
  await flush();

  const after = vi.mocked(fetch).mock.calls.map(([url]) => url);
  expect(after.filter((url) => url === "/api/systems")).toHaveLength(2);
  expect(after.filter((url) => url === "/api/containers/all")).toHaveLength(2);
  expect(pinged).toEqual(["https://a.example", "https://a.example"]);
  expect(writes).toHaveLength(0);
  expect(app.innerHTML).toBe(page);
});

it("renders only up machines with readings; others get empty meters and a non-red dot", async () => {
  const { elements } = stubDom();
  mockApi({
    systems: () => ({
      configured: true,
      systems: [
        { ...system("alive"), temp: 41, loadAvg: [0.1, 0.2, 0.3] },
        { ...system("gone"), status: "down", temp: 55, loadAvg: [1, 2, 3] },
        { ...system("napping"), status: "paused" },
      ],
    }),
  });

  await import("./main.ts");
  await flush();

  const cards = (elements.get("#systems-grid")?.innerHTML ?? "").split('<div class="system-card">');
  const [, alive, gone, napping] = cards;
  expect(alive).toContain("cpu 10%");
  expect(alive).toContain("41°C");
  expect(alive).toContain("load 0.10");

  expect(gone).toContain("cpu —");
  expect(gone).toContain('data-status="down"');
  expect(gone).toContain("down");
  expect(gone).not.toMatch(/%|°C|load/);
  expect(gone).not.toContain("meter-fill");

  expect(napping).not.toContain('data-status="down"');
  expect(napping).toContain('title="paused"');
  expect(napping).toContain("disk —");
});

it("falls back to the first letter for a blank bookmark icon", async () => {
  const { app } = stubDom();
  vi.stubGlobal("fetch", async (url: string) =>
    url === "/api/config"
      ? json({
          title: "Homie",
          groups: [
            {
              name: "g",
              bookmarks: [
                { name: "alpha", url: "https://a.example", icon: "" },
                { name: "beta", url: "https://b.example", icon: "  " },
              ],
            },
          ],
        })
      : json({ configured: false, systems: [], sources: [], containers: [] }),
  );

  await import("./main.ts");
  await flush();

  expect(app.innerHTML).toMatch(/service-icon">\s*A\s*</);
  expect(app.innerHTML).toMatch(/service-icon">\s*B\s*</);
});

it("still hides a section when localStorage.setItem throws", async () => {
  const { app } = stubDom();
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  });
  const section = Object.assign(new FakeElement(), {
    classList: { toggle: vi.fn() },
    querySelector: () => null,
  });
  Object.assign(document, { getElementById: () => section });
  vi.stubGlobal("Element", FakeElement);
  const toggle = Object.assign(new FakeElement(), { closest: () => toggle });
  toggle.dataset.sectionToggle = "services";
  mockApi();

  let onClick: ((event: Event) => void) | undefined;
  vi.spyOn(app, "addEventListener").mockImplementation((type, listener) => {
    if (type === "click") onClick = listener;
  });

  await import("./main.ts");
  await flush();

  expect(() => onClick?.({ target: toggle } as unknown as Event)).not.toThrow();
  expect(section.classList.toggle).toHaveBeenCalledWith("section-hidden", true);
});

/* --- Cached config (stale-while-revalidate) --- */

const CONFIG_KEY = "homie:config";

function cachedEntry(config: unknown, version = 3) {
  return JSON.stringify({ version, config });
}

/** A Map-backed localStorage; `seed` pre-fills the config cache entry. */
function stubStorage(seed?: string) {
  const store = new Map<string, string>();
  if (seed !== undefined) store.set(CONFIG_KEY, seed);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

/**
 * Like stubConfigFetch, but /api/config waits until the test resolves it, and
 * /api/pings streams `serverUrls`, the bookmarks in the server's current config.
 */
function stubSlowConfigFetch(serverUrls: string[] = []) {
  const config = deferred<Response>();
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      requests.push(url);
      if (url === "/api/config") return config.promise;
      if (url === "/api/systems") return Promise.resolve(json({ configured: false, systems: [] }));
      if (url === "/api/containers/all") {
        return Promise.resolve(json({ configured: false, sources: [], containers: [] }));
      }
      if (url === "/api/pings") {
        return Promise.resolve(
          ndjson(serverUrls.map((url) => ({ url, ok: true, status: 200, latencyMs: 1 }))),
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
  const pinged = () => requests.filter((url) => url === "/api/pings").flatMap(() => serverUrls);
  return { config, requests, pinged };
}

it("renders the cached config before /api/config resolves, then swaps in a changed one and pings once", async () => {
  const pings = [pingTile("https://a.example").ping];
  const { app, elements } = stubDom(pings);
  const writes = stubServices(elements, pings);
  const store = stubStorage(cachedEntry(bookmarksConfig("https://a.example")));
  const { config, requests, pinged } = stubSlowConfigFetch(["https://b.example"]);

  await import("./main.ts");
  await flush();

  expect(app.innerHTML).toContain('data-ping-url="https://a.example"');
  expect(document.title).toBe("Homie");
  expect(requests).toContain("/api/systems");
  expect(requests).toContain("/api/containers/all");
  expect(pinged()).toEqual([]);

  config.resolve(json({ ...bookmarksConfig("https://b.example"), title: "Lab" }));
  await flush();

  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain('data-ping-url="https://b.example"');
  expect(document.title).toBe("Lab");
  expect(pinged()).toEqual(["https://b.example"]);
  expect(JSON.parse(store.get(CONFIG_KEY)!).config.title).toBe("Lab");
});

it("keeps the cached page without an error notice when the fresh fetch fails", async () => {
  const pings = [pingTile("https://a.example").ping];
  const { app, elements } = stubDom(pings);
  const writes = stubServices(elements, pings);
  stubStorage(cachedEntry(bookmarksConfig("https://a.example")));
  const { config, pinged } = stubSlowConfigFetch(["https://a.example"]);

  await import("./main.ts");
  await flush();
  config.reject(new Error("offline"));
  await flush();

  expect(app.innerHTML).toContain('data-ping-url="https://a.example"');
  expect(app.innerHTML).not.toContain("failed to load config");
  expect(writes).toHaveLength(0);
  expect(pinged()).toEqual(["https://a.example"]);
});

it("does not rewrite or re-render when the fresh config matches the cached one", async () => {
  const pings = [pingTile("https://a.example").ping];
  const { elements } = stubDom(pings);
  const writes = stubServices(elements, pings);
  const store = stubStorage(cachedEntry(bookmarksConfig("https://a.example")));
  const setItem = vi.spyOn(localStorage, "setItem");
  stubConfigFetch(() => ({ ...bookmarksConfig("https://a.example"), pingTimeoutMs: 100 }));

  await import("./main.ts");
  await flush();

  expect(writes).toHaveLength(0);
  expect(setItem).not.toHaveBeenCalled();
  expect(store.has(CONFIG_KEY)).toBe(true);
});

it("never stores machines or tuning fields", async () => {
  stubDom();
  const store = stubStorage();
  stubConfigFetch(() => ({
    ...bookmarksConfig("https://a.example"),
    theme: "metal",
    openInNewTab: false,
    pingTimeoutMs: 1234,
    cacheTtlMs: 5678,
    machines: [{ name: "nas", address: "root@10.0.0.2" }],
  }));

  await import("./main.ts");
  await flush();

  const saved = JSON.parse(store.get(CONFIG_KEY)!);
  expect(saved.version).toBe(3);
  expect(Object.keys(saved.config).sort()).toEqual(["groups", "openInNewTab", "theme", "title"]);
  expect(store.get(CONFIG_KEY)).not.toMatch(/machines|10\.0\.0\.2|1234|5678/);
});

it.each([
  ["unparsable JSON", "{not json"],
  ["a different version", cachedEntry(bookmarksConfig("https://a.example"), 1)],
  ["the previous version", cachedEntry(bookmarksConfig("https://a.example"), 2)],
  [
    "invalid feeds",
    cachedEntry({ title: "x", groups: [], feeds: [{ name: "Bad", url: "javascript:alert(1)" }] }),
  ],
  ["the wrong shape", cachedEntry({ title: 5, groups: [] })],
  [
    "a bookmark without a url",
    cachedEntry({ title: "x", groups: [{ name: "g", bookmarks: [{ name: "n" }] }] }),
  ],
])("ignores a cached config with %s and loads from the network", async (_name, saved) => {
  const { app } = stubDom();
  const store = stubStorage(saved);
  const { config } = stubSlowConfigFetch();

  await import("./main.ts");
  await flush();
  expect(app.innerHTML).toBe("");

  config.resolve(json(bookmarksConfig("https://b.example")));
  await flush();

  expect(app.innerHTML).toContain("https://b.example");
  // The bad entry was replaced by the fresh config.
  expect(JSON.parse(store.get(CONFIG_KEY)!).config.groups[0].bookmarks[0].url).toBe(
    "https://b.example",
  );
});

it("loads from the network when storage is blocked", async () => {
  const { app } = stubDom();
  const blocked = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
  const { config } = stubSlowConfigFetch();

  await import("./main.ts");
  await flush();
  expect(app.innerHTML).toBe("");

  config.resolve(json(bookmarksConfig("https://b.example")));
  await flush();

  expect(app.innerHTML).toContain("https://b.example");
});

it("stamps 'checked' only after every check has settled", async () => {
  const { elements } = stubDom([pingTile("https://a.example").ping]);
  const readout = new FakeElement();
  elements.set(".app-readout", readout);
  elements.set(".app-power", new FakeElement());
  const pings = deferred<Response>();
  stubRefreshFetch({
    systems: async () => json({ configured: false, systems: [] }),
    containers: async () => json({ configured: false, sources: [], containers: [] }),
    pings: () => pings.promise,
  });

  await import("./main.ts");
  await flush();
  expect(readout.textContent).not.toContain("checked");

  pings.resolve(ndjson([{ url: "https://a.example", ok: true, status: 200, latencyMs: 1 }]));
  await flush();
  expect(readout.textContent).toContain("checked");
});

it("renders bookmarks and completes checks without waiting for cold headlines", async () => {
  const { app, elements } = stubDom();
  const readout = new FakeElement();
  elements.set(".app-readout", readout);
  elements.set(".app-power", new FakeElement());
  const headline = deferred<Response>();
  const feeds = [{ name: "Blog", url: "https://blog.test/feed" }];
  const config = { ...bookmarksConfig("https://service.test"), feeds };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/config") return json(config);
      if (url === "/api/feeds") return headline.promise;
      if (url === "/api/pings") return ndjson([]);
      if (url === "/api/systems") return json({ configured: false, systems: [] });
      if (url === "/api/containers/all")
        return json({ configured: false, sources: [], containers: [] });
      throw new Error(`unexpected request: ${url}`);
    }),
  );
  await import("./main.ts");
  await flush();
  expect(app.innerHTML).toContain("https://service.test");
  expect(app.innerHTML).toContain("Headlines");
  expect(elements.get("#feeds-list")?.innerHTML).toContain("Loading feed");
  expect(readout.textContent).toContain("checked");
  headline.resolve(
    json({
      configured: true,
      refreshing: false,
      feeds: [
        {
          id: feeds[0].url,
          name: "Blog",
          state: "ready",
          refreshing: false,
          checkedAt: "2026-11-05T12:00:00Z",
          articles: [{ title: "Latest article", url: "https://blog.test/latest" }],
        },
      ],
    }),
  );
  await flush();
  expect(elements.get("#feeds-list")?.innerHTML).toContain("Latest article");
});

it.each([
  { name: "omitted", options: {} },
  { name: "empty", options: { feeds: [] } },
])(
  "keeps existing dashboards working with $name feeds and makes no feed requests",
  async ({ options }) => {
    const url = "https://service.test";
    const tile = pingTile(url);
    const { app, elements, refresh } = stubDom([tile.ping]);
    const pinged = stubConfigFetch(() => ({ ...bookmarksConfig(url), ...options }));
    await import("./main.ts");
    await flush();
    refresh.dispatch("click");
    await flush();
    expect(app.innerHTML).toContain(url);
    expect(elements.get("#feeds")?.hidden).toBe(true);
    expect(pinged).toEqual([url, url]);
    expect(tile.dot.dataset.status).toBe("up");
    const requests = vi.mocked(fetch).mock.calls.map(([url]) => url);
    expect(requests).toContain("/api/systems");
    expect(requests).toContain("/api/containers/all");
    expect(requests).not.toContain("/api/feeds");
  },
);

it("applies feed additions, tab preference changes, and removal without reloading", async () => {
  const { elements, refresh } = stubDom();
  let feeds: Array<{ name: string; url: string }> = [];
  let openInNewTab = true;
  let feedRequests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/config") return json({ title: "Homie", groups: [], feeds, openInNewTab });
      if (url === "/api/feeds") {
        feedRequests++;
        return json({
          configured: !!feeds.length,
          refreshing: false,
          feeds: feeds.map((feed) => ({
            id: feed.url,
            name: feed.name,
            state: "ready",
            refreshing: false,
            checkedAt: "2026-11-05T12:00:00Z",
            articles: [{ title: "Hello", url: "https://blog.test/hello" }],
          })),
        });
      }
      if (url === "/api/pings") return ndjson([]);
      if (url === "/api/systems") return json({ configured: false, systems: [] });
      if (url === "/api/containers/all")
        return json({ configured: false, sources: [], containers: [] });
      throw new Error(`unexpected request: ${url}`);
    }),
  );
  await import("./main.ts");
  await flush();
  expect(feedRequests).toBe(0);
  expect(elements.get("#feeds")?.hidden).toBe(true);
  feeds = [{ name: "Blog", url: "https://blog.test/feed" }];
  refresh.dispatch("click");
  await flush();
  expect(elements.get("#feeds")?.hidden).toBe(false);
  expect(elements.get("#feeds-list")?.innerHTML).toContain('target="_blank"');
  openInNewTab = false;
  refresh.dispatch("click");
  await flush();
  expect(elements.get("#feeds-list")?.innerHTML).toContain('target="_self"');
  feeds = [];
  refresh.dispatch("click");
  await flush();
  expect(elements.get("#feeds")?.hidden).toBe(true);
  const previousRequests = feedRequests;
  refresh.dispatch("click");
  await flush();
  expect(feedRequests).toBe(previousRequests);
});

it("shows the configured weather and hides it again when the config drops it", async () => {
  const { elements, refresh } = stubDom();
  let weather: { location: string; unit: string } | undefined = { location: "Jakarta", unit: "c" };
  const report = {
    location: "Jakarta",
    place: "Jakarta, Indonesia",
    unit: "c",
    fetchedAt: "2026-11-05T12:00:00Z",
    current: { temp: 30.6, feelsLike: 35, humidity: 70, wind: 12, code: 2, isDay: true },
    days: [{ date: "2026-11-05", code: 61, max: 32, min: 25, precipChance: 40 }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/config") return json({ title: "Homie", groups: [], weather });
      if (url === "/api/weather") return json({ configured: true, report });
      if (url === "/api/pings") return ndjson([]);
      if (url === "/api/systems") return json({ configured: false, systems: [] });
      if (url === "/api/containers/all")
        return json({ configured: false, sources: [], containers: [] });
      throw new Error(`unexpected request: ${url}`);
    }),
  );
  await import("./main.ts");
  await flush();
  expect(elements.get("#weather")?.hidden).toBe(false);
  expect(elements.get("#weather-location")?.textContent).toBe("Jakarta");
  expect(elements.get("#weather-location")?.title).toBe("Jakarta, Indonesia");
  const body = elements.get("#weather-body")?.innerHTML;
  expect(body).toContain("Partly cloudy");
  expect(body).toContain("Feels like 35°");
  expect(body).toContain("40%");
  expect(body).toContain('href="https://open-meteo.com/"');

  weather = undefined;
  refresh.dispatch("click");
  await flush();
  expect(elements.get("#weather")?.hidden).toBe(true);
  const requests = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/weather");
  expect(requests).toHaveLength(1);
});
