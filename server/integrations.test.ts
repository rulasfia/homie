import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("BESZEL_URL", "https://beszel.test");
  vi.stubEnv("BESZEL_EMAIL", "homie@example.test");
  vi.stubEnv("BESZEL_PASSWORD", "test-password");
  vi.stubEnv("DOCKER_HOST", "tcp://docker.test:2375");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected test request"))),
  );
  // Never contact a real Docker daemon, even if a test forgets to provide a response.
  vi.spyOn(http, "get").mockImplementation(() => {
    throw new Error("Unexpected Docker request");
  });
  vi.spyOn(https, "get").mockImplementation(() => {
    throw new Error("Unexpected Docker request");
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function warnings() {
  return vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(line));
}

it("logs failed bookmark status and recovery without changing HEAD fallback", async () => {
  const { pingUrl } = await import("./ping.ts");
  vi.mocked(fetch)
    .mockResolvedValueOnce(new Response(null, { status: 405 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  const url = "https://host.test/path?token=test-secret#test-fragment";
  expect(await pingUrl(url, 2000, "Jellyfin")).toMatchObject({ ok: false, status: 503 });
  expect(fetch).toHaveBeenNthCalledWith(2, url, expect.objectContaining({ method: "GET" }));
  expect(warnings()).toEqual([
    expect.objectContaining({
      event: "bookmark.check.failed",
      bookmark: "Jellyfin",
      target: "https://host.test/path",
      httpStatus: 503,
      timeoutMs: 2000,
    }),
  ]);
  await pingUrl(url, 2000, "Jellyfin");
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining("bookmark.check.recovered"));
  expect(JSON.stringify(warnings())).not.toContain("test-secret");
});

it("logs the root network cause for unreachable bookmarks", async () => {
  const { pingUrl } = await import("./ping.ts");
  vi.mocked(fetch).mockRejectedValue(
    new TypeError("fetch failed: secret", {
      cause: Object.assign(new Error("secret"), { code: "ENOTFOUND" }),
    }),
  );
  expect(await pingUrl("https://missing.test")).toMatchObject({ ok: false, status: null });
  expect(warnings()).toEqual([expect.objectContaining({ error: "TypeError -> ENOTFOUND" })]);
});

it("logs Beszel authentication status without logging credentials", async () => {
  const { getSystems } = await import("./beszel.ts");
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }));
  await expect(getSystems()).rejects.toThrow();
  expect(warnings()).toEqual([
    expect.objectContaining({
      event: "beszel.systems.failed",
      target: "https://beszel.test/",
      operation: "authenticate",
      httpStatus: 403,
    }),
  ]);
  expect(JSON.stringify(warnings())).not.toMatch(/test-password|homie@example/);
});

it("adds a timeout to Beszel requests and logs timeout failures", async () => {
  const { getSystems } = await import("./beszel.ts");
  vi.mocked(fetch).mockRejectedValue(new DOMException("secret", "TimeoutError"));
  await expect(getSystems()).rejects.toThrow();
  expect(fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      signal: expect.any(AbortSignal),
    }),
  );
  expect(warnings()).toEqual([
    expect.objectContaining({
      timeoutMs: 5000,
      operation: "authenticate",
      error: "Error -> TimeoutError",
    }),
  ]);
});

it("logs offline machines once and records recovery, but ignores paused machines", async () => {
  const { getSystems } = await import("./beszel.ts");
  let status = "down";
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (typeof url !== "string") throw new Error("Expected a URL string");
    if (url.includes("auth-with-password")) return Response.json({ token: "test-token" });
    if (url.includes("/systems/"))
      return Response.json({
        items: [
          { id: "server", name: "homeserver", status, info: {} },
          { id: "paused", name: "backup", status: "paused", info: {} },
        ],
      });
    return Response.json({ items: [] });
  });
  await getSystems();
  await getSystems();
  expect(warnings()).toEqual([
    expect.objectContaining({
      event: "beszel.machine.failed",
      machine: "homeserver",
      systemId: "server",
      status: "down",
    }),
  ]);
  status = "up";
  await getSystems();
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining("beszel.machine.recovered"));
});

it("logs per-machine container-stat failures while preserving the older-hub fallback", async () => {
  const { getRemoteContainers } = await import("./beszel.ts");
  let statsStatus = 404;
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (typeof url !== "string") throw new Error("Expected a URL string");
    if (url.includes("auth-with-password")) return Response.json({ token: "test-token" });
    if (url.includes("/systems/"))
      return Response.json({
        items: [{ id: "server", name: "homeserver", status: "up", info: {} }],
      });
    return statsStatus === 200
      ? Response.json({ items: [] })
      : new Response(null, { status: statsStatus });
  });
  const response = await getRemoteContainers();
  expect(response).toMatchObject({
    configured: true,
    bySystem: [
      {
        systemId: "server",
        systemName: "homeserver",
        systemStatus: "up",
        containers: [],
      },
    ],
  });
  expect(response.bySystem[0]).not.toHaveProperty("error");
  expect(warnings()).toEqual([
    expect.objectContaining({
      event: "beszel.container_stats.failed",
      machine: "homeserver",
      systemId: "server",
      httpStatus: 404,
    }),
  ]);
  statsStatus = 200;
  await getRemoteContainers();
  expect(console.info).toHaveBeenCalledWith(
    expect.stringContaining("beszel.container_stats.recovered"),
  );
});

it("keeps healthy machines when one container-stat request fails", async () => {
  const { getRemoteContainers } = await import("./beszel.ts");
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (typeof url !== "string") throw new Error("Expected a URL string");
    if (url.includes("auth-with-password")) return Response.json({ token: "test-token" });
    if (url.includes("/systems/"))
      return Response.json({
        items: [
          { id: "server", name: "homeserver", host: "server.test", status: "up", info: {} },
          { id: "broken", name: "broken", host: "broken.test", status: "up", info: {} },
          { id: "empty", name: "empty", host: "empty.test", status: "up", info: {} },
        ],
      });

    const decoded = decodeURIComponent(url);
    if (decoded.includes("system='server'"))
      return Response.json({
        items: [
          {
            id: "stats",
            system: "server",
            created: "2026-11-04T12:00:00Z",
            stats: [{ n: "jellyfin", c: 12 }],
          },
        ],
      });
    if (decoded.includes("system='broken'")) throw new TypeError("secret upstream failure");
    return Response.json({ items: [] });
  });

  const result = await getRemoteContainers();
  expect(result.bySystem).toMatchObject([
    {
      systemId: "server",
      systemName: "homeserver",
      containers: [{ name: "jellyfin", cpuPct: 12 }],
    },
    {
      systemId: "broken",
      systemName: "broken",
      containers: [],
      error: "container stats unavailable",
    },
    {
      systemId: "empty",
      systemName: "empty",
      containers: [],
    },
  ]);
  expect(result.bySystem[2]).not.toHaveProperty("error");
  expect(JSON.stringify(result)).not.toContain("secret upstream failure");
});

it("normalizes current Beszel container memory and network metrics", async () => {
  const { getRemoteContainers } = await import("./beszel.ts");
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (typeof url !== "string") throw new Error("Expected a URL string");
    if (url.includes("auth-with-password")) return Response.json({ token: "test-token" });
    if (url.includes("/systems/"))
      return Response.json({
        items: [{ id: "server", name: "homeserver", status: "up", info: {} }],
      });
    return Response.json({
      items: [
        {
          id: "stats",
          system: "server",
          created: "2026-11-04T12:00:00Z",
          stats: [
            { n: "broken", c: -1, m: -2, b: [100] },
            { n: "jellyfin", c: 12.5, m: 512.25, b: [1536, 2621440] },
            { n: "overflow", m: Number.MAX_VALUE },
            { n: "partial", b: [100, -5] },
            { n: "zero", c: 0, m: 0, b: [0, 0] },
          ],
        },
      ],
    });
  });

  const result = await getRemoteContainers();
  expect(result.bySystem[0].containers).toEqual([
    { name: "broken" },
    {
      name: "jellyfin",
      cpuPct: 12.5,
      memBytes: 537133056,
      netSentBps: 1536,
      netRecvBps: 2621440,
    },
    { name: "overflow" },
    { name: "partial", netSentBps: 100 },
    { name: "zero", cpuPct: 0, memBytes: 0, netSentBps: 0, netRecvBps: 0 },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/memPct|netBytes/);
});

function mockDocker(body: unknown, statusCode = 200, error?: Error) {
  const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn() });
  vi.mocked(http.get).mockImplementationOnce((...args: unknown[]) => {
    queueMicrotask(() => {
      if (error) {
        request.emit("error", error);
        return;
      }
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback !== "function") throw new Error("Docker callback missing");
      const response = Object.assign(new EventEmitter(), { statusCode, setEncoding: vi.fn() });
      callback(response);
      response.emit("data", JSON.stringify(body));
      response.emit("end");
    });
    return request as unknown as http.ClientRequest;
  });
}

it("logs Docker API errors and recovery with a sanitized target", async () => {
  vi.stubEnv("DOCKER_HOST", "tcp://user:test-password@docker.test:2375?token=test-secret");
  const { getContainers } = await import("./docker.ts");
  mockDocker({}, 503);
  await expect(getContainers()).rejects.toThrow();
  expect(warnings()).toEqual([
    expect.objectContaining({
      event: "docker.containers.failed",
      target: "tcp://docker.test:2375",
      httpStatus: 503,
    }),
  ]);
  expect(JSON.stringify(warnings())).not.toMatch(/test-password|test-secret/);
  mockDocker([]);
  expect(await getContainers()).toEqual([]);
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining("docker.containers.recovered"));
});

it("logs Docker socket error codes", async () => {
  const { getContainers } = await import("./docker.ts");
  mockDocker(null, 200, Object.assign(new Error("secret"), { code: "EACCES" }));
  await expect(getContainers()).rejects.toThrow();
  expect(warnings()).toEqual([
    expect.objectContaining({
      event: "docker.containers.failed",
      error: "EACCES",
    }),
  ]);
});

it("logs unhealthy/restarting containers but not deliberately stopped containers", async () => {
  const { getContainers } = await import("./docker.ts");
  const container = { Id: "0123456789abcdef", Names: ["/jellyfin"], Image: "jellyfin", Ports: [] };
  mockDocker([
    { ...container, State: "running", Status: "Up 1 hour (unhealthy)" },
    { ...container, Id: "stopped", State: "exited", Status: "Exited (0) 1 hour ago" },
  ]);
  await getContainers();
  expect(warnings()).toEqual([
    expect.objectContaining({
      event: "docker.container.failed",
      container: "jellyfin",
      state: "running",
      unhealthy: true,
    }),
  ]);
  mockDocker([{ ...container, State: "restarting", Status: "Restarting" }]);
  await getContainers();
  expect(warnings()).toHaveLength(2);
  mockDocker([{ ...container, State: "running", Status: "Up 1 minute (healthy)" }]);
  await getContainers();
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining("docker.container.recovered"));
});
