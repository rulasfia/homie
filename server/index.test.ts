import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import "./index.ts";
import { ConfigValidationError } from "./config.ts";

const bookmarkUrl = "https://example.com/";

const state = vi.hoisted(() => ({
  handler: undefined as
    | ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>)
    | undefined,
}));
const loadConfig = vi.hoisted(() => vi.fn());
const pingUrl = vi.hoisted(() => vi.fn());

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
      state.handler = handler;
      return { on: vi.fn(), listen: vi.fn() };
    },
  };
});

vi.mock("./config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.ts")>();
  return { ...actual, loadConfig };
});

vi.mock("./ping.ts", () => ({ pingUrl }));

beforeEach(() => {
  vi.clearAllMocks();
  loadConfig.mockResolvedValue({
    title: "homie",
    pingTimeoutMs: 1000,
    cacheTtlMs: 0,
    groups: [{ name: "Links", bookmarks: [{ name: "Example", url: bookmarkUrl, ping: true }] }],
  });
  pingUrl.mockResolvedValue({ ok: true, status: 204, latencyMs: 3 });
});

function createRequest(url: string | undefined, host?: string): IncomingMessage {
  return { url, headers: host === undefined ? {} : { host } } as IncomingMessage;
}

/** Records what the handler sends; `body` collects streamed writes and the final end. */
function createResponse() {
  const res = Object.assign(new EventEmitter(), {
    status: undefined as number | undefined,
    headers: {} as Record<string, string>,
    preset: {} as Record<string, string>,
    body: "",
    ended: false,
    setHeader(name: string, value: string) {
      res.preset[name] = value;
    },
    writeHead(status: number, headers: Record<string, string> = {}) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    write(chunk: string) {
      res.body += chunk;
      return true;
    },
    end(body?: string) {
      res.body += body ?? "";
      res.ended = true;
      return res;
    },
  });
  return res;
}

function startRequest(url: string | undefined, host?: string) {
  const res = createResponse();
  if (!state.handler) throw new Error("request handler was not registered");
  const done = state.handler(createRequest(url, host), res as unknown as ServerResponse);
  return { res, done };
}

async function handle(url: string | undefined, host?: string) {
  const { res, done } = startRequest(url, host);
  await done;
  return res;
}

function lines(body: string) {
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

it.each([
  ["a JSON response", "/api/config"],
  ["an API 404", "/api/nope"],
  ["the NDJSON stream", "/api/pings"],
  ["a static path", "/favicon.svg"],
  ["a bad request", "http://%"],
])("sets hardening headers on %s", async (_name, target) => {
  const res = await handle(target, "localhost");
  expect(res.preset).toEqual({
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
});

it.each(["http://%", "http://[invalid", "http://host:badport"])(
  "returns 400 for malformed request target %s",
  async (target) => {
    const res = await handle(target, "localhost");
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "bad request" });
    expect(loadConfig).not.toHaveBeenCalled();
  },
);

it.each(["%", "[invalid", "localhost:badport"])(
  "ignores malformed Host header %s without crashing",
  async (host) => {
    const res = await handle("/api/pings", host);
    expect(res.status).toBe(200);
    expect(pingUrl).toHaveBeenCalledWith(bookmarkUrl, 1000, "Example", {
      expectStatus: undefined,
      insecure: false,
    });
  },
);

it("streams one NDJSON line per unique pinged config URL and ignores client query", async () => {
  loadConfig.mockResolvedValue({
    title: "homie",
    pingTimeoutMs: 1000,
    cacheTtlMs: 0,
    groups: [
      { name: "A", bookmarks: [{ name: "Example", url: bookmarkUrl, ping: true }] },
      {
        name: "B",
        bookmarks: [
          { name: "Again", url: bookmarkUrl, ping: true },
          { name: "Quiet", url: "https://quiet.example/" },
          { name: "Other", url: "https://other.example/", ping: true },
        ],
      },
    ],
  });
  const res = await handle("/api/pings?url=https%3A%2F%2Fevil.example%2F");

  expect(res.status).toBe(200);
  expect(res.headers).toEqual({
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  expect(res.ended).toBe(true);
  expect(lines(res.body)).toEqual([
    { url: bookmarkUrl, ok: true, status: 204, latencyMs: 3 },
    { url: "https://other.example/", ok: true, status: 204, latencyMs: 3 },
  ]);
  expect(pingUrl.mock.calls.map(([url]) => url)).toEqual([bookmarkUrl, "https://other.example/"]);
});

it("stops writing pings once the client disconnects", async () => {
  loadConfig.mockResolvedValue({
    title: "homie",
    pingTimeoutMs: 1000,
    cacheTtlMs: 0,
    groups: [
      {
        name: "Links",
        bookmarks: [
          { name: "Fast", url: bookmarkUrl, ping: true },
          { name: "Slow", url: "https://slow.example/", ping: true },
        ],
      },
    ],
  });
  let finishSlow!: (value: unknown) => void;
  pingUrl.mockImplementation(async (url: string) =>
    url === bookmarkUrl
      ? { ok: true, status: 200, latencyMs: 1 }
      : new Promise((resolve) => (finishSlow = resolve)),
  );
  const { res, done } = startRequest("/api/pings");
  await vi.waitFor(() => expect(lines(res.body)).toHaveLength(1));

  res.emit("close");
  finishSlow({ ok: false, status: null, latencyMs: 1000, error: "timed out" });
  await done;
  expect(lines(res.body)).toHaveLength(1);
  expect(res.ended).toBe(false);
});

it("routes absolute-form request targets by pathname", async () => {
  const res = await handle("http://proxy.example:8080/api/pings");
  expect(res.status).toBe(200);
  expect(pingUrl).toHaveBeenCalledWith(bookmarkUrl, 1000, "Example", {
    expectStatus: undefined,
    insecure: false,
  });
});

it.each(["/api/nope", "/api/nope/deeper", "/api", "/api/containers", "/api/containers/remote"])(
  "returns a JSON 404 for unknown API path %s",
  async (path) => {
    const res = await handle(path);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not found" });
  },
);

it("still returns 500 when a handler fails", async () => {
  loadConfig.mockRejectedValueOnce(new Error("config unavailable"));
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await handle("/api/config");
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "internal error" });
  } finally {
    consoleError.mockRestore();
  }
});

it("exposes only safe validation diagnostics for invalid configuration", async () => {
  const message = "invalid homie config: groups[0].bookmarks must be an array";
  loadConfig.mockRejectedValueOnce(new ConfigValidationError(message));
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await handle("/api/config");
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: message });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(message));
  } finally {
    consoleError.mockRestore();
  }
});

it.each([
  ["expectStatus", { expectStatus: [404] }, { expectStatus: [200] }],
  ["insecure", { insecure: true }, {}],
])("passes %s to pingUrl and keys the ping cache on it", async (_, before, after) => {
  const config = (options: object) => ({
    title: "homie",
    pingTimeoutMs: 1000,
    cacheTtlMs: 60_000,
    groups: [
      { name: "Links", bookmarks: [{ name: "Example", url: bookmarkUrl, ping: true, ...options }] },
    ],
  });
  loadConfig.mockResolvedValue(config(before));
  await handle("/api/pings");
  await handle("/api/pings");
  expect(pingUrl).toHaveBeenCalledTimes(1);
  expect(pingUrl).toHaveBeenLastCalledWith(bookmarkUrl, 1000, "Example", {
    expectStatus: undefined,
    insecure: false,
    ...before,
  });

  // Changing the option in the config must not serve the cached result.
  loadConfig.mockResolvedValue(config(after));
  await handle("/api/pings");
  expect(pingUrl).toHaveBeenCalledTimes(2);
  expect(pingUrl).toHaveBeenLastCalledWith(bookmarkUrl, 1000, "Example", {
    expectStatus: undefined,
    insecure: false,
    ...after,
  });
});
