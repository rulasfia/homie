import { afterEach, expect, it, vi } from "vite-plus/test";

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

type ApiHandler = () => unknown;

function mockApi(
  handlers: { systems?: ApiHandler; containers?: ApiHandler; ping?: ApiHandler } = {},
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
      if (url.startsWith("/api/ping?")) {
        return json(handlers.ping?.() ?? { ok: true, status: 200, latencyMs: 1 });
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
}

function stubRefreshFetch(handlers: {
  systems: () => Promise<Response>;
  containers: () => Promise<Response>;
  ping?: (url: string) => Promise<Response>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/config") {
        return Promise.resolve(json({ title: "Homie", groups: [] }));
      }
      if (url === "/api/systems") return handlers.systems();
      if (url === "/api/containers/all") return handlers.containers();
      if (url.startsWith("/api/ping?url=")) {
        const pingUrl = decodeURIComponent(url.slice("/api/ping?url=".length));
        return handlers.ping?.(pingUrl) ?? Promise.resolve(json({ ok: true, latencyMs: 1 }));
      }
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
  ]);
  const theme = new FakeElement();
  const refresh = new FakeElement();
  const app = Object.assign(new FakeElement(), {
    querySelector: (selector: string) =>
      selector === ".app-theme" ? theme : selector === ".app-refresh" ? refresh : null,
  });

  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", {
    title: "",
    documentElement: { dataset: {} },
    querySelector: (selector: string) =>
      selector === "#app" ? app : (elements.get(selector) ?? null),
    querySelectorAll: (selector: string) => (selector === "[data-ping-url]" ? pings : []),
  });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: false }));
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

it("deduplicates pings by URL and updates every matching tile", async () => {
  const first = pingTile("https://example.com");
  const duplicate = pingTile("https://example.com");
  const other = pingTile("https://other.example");
  const { refresh } = stubDom([first.ping, duplicate.ping, other.ping]);
  const pingRequests: Array<{ url: string; request: Deferred<Response> }> = [];
  stubRefreshFetch({
    systems: () => Promise.resolve(json({ configured: false, systems: [] })),
    containers: () => Promise.resolve(json({ configured: false, sources: [], containers: [] })),
    ping: (url) => {
      const request = deferred<Response>();
      pingRequests.push({ url, request });
      return request.promise;
    },
  });

  await import("./main.ts");
  await flush();
  expect(pingRequests.map(({ url }) => url)).toEqual([
    "https://example.com",
    "https://other.example",
  ]);

  refresh.dispatch("click");
  await flush();
  expect(pingRequests).toHaveLength(2);

  pingRequests[0].request.resolve(json({ ok: true, status: 200, latencyMs: 12 }));
  await flush();
  for (const tile of [first, duplicate]) {
    expect(tile.dot.dataset.status).toBe("up");
    expect(tile.latency.hidden).toBe(false);
    expect(tile.latency.textContent).toBe("12ms");
  }
  expect(other.latency.hidden).toBe(true);

  pingRequests[1].request.resolve(json({ ok: true, status: 204, latencyMs: 5 }));
  await flush();
  expect(other.dot.dataset.status).toBe("up");
  expect(other.latency.textContent).toBe("5ms");

  refresh.dispatch("click");
  await flush();
  expect(pingRequests).toHaveLength(4);
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
    ping: () => {
      if (fail) throw new Error("offline");
      return { ok: true, status: 200, latencyMs: 12 };
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
