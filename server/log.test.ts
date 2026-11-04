import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  ["https://user:password@host.test/path?token=secret#secret", "https://host.test/path"],
  ["tcp://user:password@docker.test:2375?token=secret", "tcp://docker.test:2375"],
  ["/var/run/docker.sock", "/var/run/docker.sock"],
  ["https://user:password@", "[invalid URL]"],
  ["mailto:user:password@host.test", "[unsupported URL]"],
  [undefined, undefined],
])("sanitizes log target %s", async (target, expected) => {
  const { safeTarget } = await import("./log.ts");
  expect(safeTarget(target)).toBe(expected);
});

it("extracts HTTP and nested network diagnostics without error messages or stacks", async () => {
  const { errorDetails } = await import("./log.ts");
  const networkError = Object.assign(new Error("password=secret"), { code: "ECONNREFUSED" });
  const error = Object.assign(
    new Error("https://user:secret@host.test", {
      cause: new AggregateError([networkError], "token=secret"),
    }),
    { httpStatus: 503, operation: "authenticate" },
  );
  expect(errorDetails(error)).toEqual({
    httpStatus: 503,
    operation: "authenticate",
    error: "Error -> AggregateError -> ECONNREFUSED",
  });
  expect(errorDetails("secret")).toEqual({ error: "UnknownError" });
});

it("logs failures, changed causes, reminders, and recovery without poll spam", async () => {
  const { reportHealth } = await import("./log.ts");
  const fields = { target: "https://host.test/", httpStatus: 503, latencyMs: 10 };
  reportHealth("test", true, "bookmark.check", fields);
  expect(console.info).not.toHaveBeenCalled();

  reportHealth("test", false, "bookmark.check", fields);
  expect(JSON.parse(vi.mocked(console.warn).mock.calls[0][0])).toMatchObject({
    timestamp: "2026-11-04T12:00:00.000Z",
    level: "warn",
    event: "bookmark.check.failed",
    ...fields,
  });
  reportHealth("test", false, "bookmark.check", { ...fields, latencyMs: 20 });
  expect(console.warn).toHaveBeenCalledTimes(1);

  reportHealth("test", false, "bookmark.check", { ...fields, httpStatus: 502 });
  expect(console.warn).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(5 * 60_000);
  reportHealth("test", false, "bookmark.check", { ...fields, httpStatus: 502 });
  expect(console.warn).toHaveBeenCalledTimes(3);

  reportHealth("test", true, "bookmark.check", { httpStatus: 200 });
  reportHealth("test", true, "bookmark.check", { httpStatus: 200 });
  expect(console.info).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({
    event: "bookmark.check.recovered",
    outageMs: 300_000,
    httpStatus: 200,
  });
  reportHealth("test", false, "bookmark.check", fields);
  expect(console.warn).toHaveBeenCalledTimes(4);
});

it("preserves upstream results and errors", async () => {
  const { monitor } = await import("./log.ts");
  const error = Object.assign(new Error("secret"), { code: "ENOTFOUND" });
  await expect(monitor("test", "docker.containers", {}, () => Promise.reject(error))).rejects.toBe(
    error,
  );
  const containers = [{ name: "homie" }];
  await expect(monitor("test", "docker.containers", {}, async () => containers)).resolves.toBe(
    containers,
  );
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(console.info).toHaveBeenCalledTimes(1);
});

it("logs unexpected API errors, but does not duplicate upstream failures at the route", async () => {
  const { monitor, logError } = await import("./log.ts");
  const error = new Error("secret");
  await expect(monitor("test", "beszel.systems", {}, () => Promise.reject(error))).rejects.toBe(
    error,
  );
  logError("api.request.failed", error, { path: "/api/systems" });
  expect(console.error).not.toHaveBeenCalled();

  logError("api.request.failed", new TypeError("secret"), { path: "/api/containers/all" });
  expect(JSON.parse(vi.mocked(console.error).mock.calls[0][0])).toMatchObject({
    level: "error",
    event: "api.request.failed",
    path: "/api/containers/all",
    error: "TypeError",
  });
  expect(vi.mocked(console.error).mock.calls[0][0]).not.toContain("secret");
});
