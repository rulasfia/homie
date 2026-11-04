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
    groups: [{ name: "Links", bookmarks: [{ name: "Example", url: bookmarkUrl }] }],
  });
  pingUrl.mockResolvedValue({ ok: true, status: 204, latencyMs: 3 });
});

function createRequest(url: string | undefined, host?: string): IncomingMessage {
  return { url, headers: host === undefined ? {} : { host } } as IncomingMessage;
}

function createResponse() {
  const res = {
    status: undefined as number | undefined,
    body: "",
    writeHead(status: number) {
      res.status = status;
      return res;
    },
    end(body?: string) {
      res.body = body ?? "";
      return res;
    },
  };
  return res;
}

async function handle(url: string | undefined, host?: string) {
  const res = createResponse();
  if (!state.handler) throw new Error("request handler was not registered");
  await state.handler(createRequest(url, host), res as unknown as ServerResponse);
  return res;
}

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
    const res = await handle(`/api/ping?url=${encodeURIComponent(bookmarkUrl)}`, host);
    expect(res.status).toBe(200);
    expect(pingUrl).toHaveBeenCalledWith(bookmarkUrl, 1000, "Example", undefined);
  },
);

it("passes allowlisted ping query parameters through to pingUrl", async () => {
  const res = await handle(
    `/api/ping?url=${encodeURIComponent(bookmarkUrl)}&ignored=1`,
    "localhost:3000",
  );
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ ok: true, status: 204, latencyMs: 3 });
  expect(pingUrl).toHaveBeenCalledWith(bookmarkUrl, 1000, "Example", undefined);
});

it("rejects ping targets that are not in the config", async () => {
  const res = await handle("/api/ping?url=https%3A%2F%2Fevil.example%2F");
  expect(res.status).toBe(400);
  expect(JSON.parse(res.body)).toEqual({ error: "url not in config" });
  expect(pingUrl).not.toHaveBeenCalled();
});

it("routes absolute-form request targets by pathname", async () => {
  const res = await handle(
    `http://proxy.example:8080/api/ping?url=${encodeURIComponent(bookmarkUrl)}`,
  );
  expect(res.status).toBe(200);
  expect(pingUrl).toHaveBeenCalledWith(bookmarkUrl, 1000, "Example", undefined);
});

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

it("passes expectStatus to pingUrl and keys the cache on it", async () => {
  const config = (expectStatus?: number[]) => ({
    title: "homie",
    pingTimeoutMs: 1000,
    cacheTtlMs: 60_000,
    groups: [{ name: "Links", bookmarks: [{ name: "Example", url: bookmarkUrl, expectStatus }] }],
  });
  const query = `/api/ping?url=${encodeURIComponent(bookmarkUrl)}`;
  loadConfig.mockResolvedValueOnce(config([404]));
  await handle(query);
  expect(pingUrl).toHaveBeenLastCalledWith(bookmarkUrl, 1000, "Example", [404]);
  loadConfig.mockResolvedValueOnce(config([200]));
  await handle(query);
  expect(pingUrl).toHaveBeenCalledTimes(2);
});
