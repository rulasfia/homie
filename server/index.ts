import { createServer, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import type {
  ContainerInfo,
  PingResult,
  RemoteContainersResponse,
  SystemStatus,
} from "../shared/types.ts";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { loadConfig, bookmarkUrls, ConfigValidationError } from "./config.ts";
import { pingUrl } from "./ping.ts";
import { beszelConfigured, getRemoteContainers, getSystems } from "./beszel.ts";
import { aggregateContainers } from "./containers.ts";
import { dockerConfigured, getContainers } from "./docker.ts";
import { Cache, cached } from "./cache.ts";
import { errorDetails, logError, logEvent } from "./log.ts";
import { parseRequestUrl } from "./request-url.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DIST_DIR = join(import.meta.dirname, "..", "dist");

const systemsCache = new Cache<SystemStatus[]>();
const containersCache = new Cache<ContainerInfo[]>();
const remoteContainersCache = new Cache<RemoteContainersResponse>();
const pingCache = new Cache<PingResult>();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  // Prevent directory traversal, fall back to index.html for unknown paths.
  const safePath = normalize(path).replace(/^(\.\.[/\\])+/, "");
  let servedPath = safePath;
  let file: Buffer | null;
  try {
    file = await readFile(join(DIST_DIR, safePath));
  } catch {
    servedPath = "index.html";
    file = await readFile(join(DIST_DIR, "index.html")).catch(() => null);
  }
  if (file === null) {
    res.writeHead(404).end("not found — run `vp build` first");
    return;
  }
  const type = MIME_TYPES[extname(servedPath)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(file);
}

const server = createServer(async (req, res) => {
  const url = parseRequestUrl(req.url);
  if (url === null) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }

  try {
    if (url.pathname === "/api/config") {
      sendJson(res, 200, await loadConfig());
      return;
    }

    if (url.pathname === "/api/ping") {
      const target = url.searchParams.get("url");
      const config = await loadConfig();
      // Only ping URLs declared in the config — never arbitrary URLs.
      if (!target || !bookmarkUrls(config).has(target)) {
        sendJson(res, 400, { error: "url not in config" });
        return;
      }
      const ttlMs = config.cacheTtlMs ?? 5000;
      const pingKey = `${target}:${config.pingTimeoutMs ?? 5000}`;
      const bookmark = config.groups
        .flatMap((group) => group.bookmarks)
        .find((b) => b.url === target);
      const result = await cached(pingCache, pingKey, ttlMs, () =>
        pingUrl(target, config.pingTimeoutMs, bookmark?.name),
      );
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/systems") {
      const config = await loadConfig();
      if (!beszelConfigured()) {
        sendJson(res, 200, { configured: false, systems: [] });
        return;
      }
      try {
        const systems = await cached(systemsCache, "systems", config.cacheTtlMs ?? 5000, () =>
          getSystems(),
        );
        const addresses = new Map(
          config.machines
            ?.filter((machine) => machine.address?.trim())
            .map((machine) => [machine.name, machine.address]),
        );
        sendJson(res, 200, {
          configured: true,
          systems: systems.map((system) => ({
            ...system,
            address: addresses.get(system.name),
          })),
        });
      } catch (err) {
        logError("api.request.failed", err, { path: url.pathname });
        sendJson(res, 502, { configured: true, systems: [], error: "beszel unreachable" });
      }
      return;
    }

    if (url.pathname === "/api/containers") {
      const config = await loadConfig();
      if (!dockerConfigured()) {
        sendJson(res, 200, { configured: false, containers: [] });
        return;
      }
      try {
        const containers = await cached(
          containersCache,
          "containers",
          config.cacheTtlMs ?? 5000,
          () => getContainers(),
        );
        sendJson(res, 200, { configured: true, containers });
      } catch (err) {
        logError("api.request.failed", err, { path: url.pathname });
        sendJson(res, 502, { configured: true, containers: [], error: "docker unreachable" });
      }
      return;
    }

    if (url.pathname === "/api/containers/all") {
      const config = await loadConfig();
      const ttlMs = config.cacheTtlMs ?? 5000;
      const hasDocker = dockerConfigured();
      const hasBeszel = beszelConfigured();

      const { status, body } = await aggregateContainers({
        local: hasDocker
          ? {
              name: hostname(),
              load: () => cached(containersCache, "containers", ttlMs, () => getContainers()),
            }
          : undefined,
        remote: hasBeszel
          ? {
              load: () =>
                cached(remoteContainersCache, "remote", ttlMs, () => getRemoteContainers()),
            }
          : undefined,
        onError: (source, err) =>
          logError("api.request.failed", err, { path: url.pathname, source }),
      });

      sendJson(res, status, body);
      return;
    }

    if (url.pathname === "/api/containers/remote") {
      const config = await loadConfig();
      if (!beszelConfigured()) {
        sendJson(res, 200, { configured: false, bySystem: [] });
        return;
      }
      try {
        const response = await cached(
          remoteContainersCache,
          "remote",
          config.cacheTtlMs ?? 5000,
          () => getRemoteContainers(),
        );
        sendJson(res, 200, response);
      } catch (err) {
        logError("api.request.failed", err, { path: url.pathname });
        sendJson(res, 502, { configured: true, bySystem: [], error: "beszel unreachable" });
      }
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (err) {
    const configError = err instanceof ConfigValidationError;
    logError("api.request.failed", err, {
      path: url.pathname,
      ...(configError ? { validationError: err.message } : {}),
    });
    sendJson(res, 500, {
      error: configError && url.pathname === "/api/config" ? err.message : "internal error",
    });
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  logEvent("error", "server.failed", { port: PORT, ...errorDetails(err) });
  process.exit(1);
});

server.listen(PORT, () => {
  logEvent("info", "server.listening", {
    url: `http://localhost:${PORT}`,
    port: PORT,
    beszelConfigured: beszelConfigured(),
    dockerConfigured: dockerConfigured(),
  });
  const beszelVariables = ["BESZEL_URL", "BESZEL_EMAIL", "BESZEL_PASSWORD"];
  if (beszelVariables.some((name) => process.env[name]) && !beszelConfigured()) {
    logEvent("warn", "beszel.configuration.incomplete", {
      missing: beszelVariables.filter((name) => !process.env[name]).join(", "),
    });
  }
  if ((process.env.DOCKER_HOST || process.env.DOCKER_SOCKET) && !dockerConfigured()) {
    logEvent("warn", "docker.configuration.unavailable", {
      hint: "Check DOCKER_HOST protocol or Docker socket path and mount",
    });
  }
});
