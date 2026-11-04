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
