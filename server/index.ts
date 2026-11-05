import { createServer, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import type {
  Bookmark,
  ContainerInfo,
  HomieConfig,
  PingResult,
  RemoteContainersResponse,
  SystemStatus,
} from "../shared/types.ts";
import { loadConfig, ConfigValidationError } from "./config.ts";
import { pingUrl } from "./ping.ts";
import { beszelConfigured, getRemoteContainers, getSystems } from "./beszel.ts";
import { aggregateContainers } from "./containers.ts";
import { dockerConfigured, getContainers } from "./docker.ts";
import { Cache, cached } from "./cache.ts";
import { errorDetails, logError, logEvent } from "./log.ts";
import { parseRequestUrl } from "./request-url.ts";
import { serveStatic } from "./static.ts";
import { FeedCache } from "./feeds.ts";
import { WeatherCache } from "./weather.ts";

const PORT = Number(process.env.PORT ?? 3000);

const systemsCache = new Cache<SystemStatus[]>();
const containersCache = new Cache<ContainerInfo[]>();
const remoteContainersCache = new Cache<RemoteContainersResponse>();
const pingCache = new Cache<PingResult>();
const feedCache = new FeedCache();
const weatherCache = new WeatherCache();

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** Pings one bookmark through the shared cache, keyed on every option that changes the result. */
function pingBookmark(bookmark: Bookmark, config: HomieConfig) {
  const { url, name, expectStatus, insecure = false } = bookmark;
  const pingKey = [url, config.pingTimeoutMs ?? 5000, expectStatus?.join(",") ?? "", insecure].join(
    ":",
  );
  return cached(pingCache, pingKey, config.cacheTtlMs ?? 5000, () =>
    pingUrl(url, config.pingTimeoutMs, name, { expectStatus, insecure }),
  );
}

/**
 * Pings every `ping: true` bookmark in the config (first bookmark per URL wins)
 * and writes one NDJSON line `{ url, ...PingResult }` per URL as soon as its
 * check settles. Only config URLs are pinged, never anything from the client.
 * Lines stop once the response closes, e.g. when the client disconnects.
 */
async function streamPings(res: ServerResponse, config: HomieConfig) {
  const targets = new Map<string, Bookmark>();
  for (const bookmark of config.groups.flatMap((group) => group.bookmarks)) {
    if (bookmark.ping && !targets.has(bookmark.url)) targets.set(bookmark.url, bookmark);
  }

  let closed = false;
  res.once("close", () => (closed = true));
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  await Promise.all(
    [...targets.values()].map(async (bookmark) => {
      // Headers are sent, so a failure cannot become a 500; the client marks a missing line failed.
      const result = await pingBookmark(bookmark, config).catch((err: unknown) => {
        logError("api.request.failed", err, { path: "/api/pings" });
      });
      if (result && !closed) res.write(`${JSON.stringify({ url: bookmark.url, ...result })}\n`);
    }),
  );
  if (!closed) res.end();
}

const server = createServer(async (req, res) => {
  // Every response, including errors, streams and 304s; writeHead keeps these.
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");

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

    if (url.pathname === "/api/pings") {
      await streamPings(res, await loadConfig());
      return;
    }

    if (url.pathname === "/api/feeds") {
      res.setHeader("cache-control", "no-store");
      sendJson(res, 200, feedCache.get((await loadConfig()).feeds));
      return;
    }

    if (url.pathname === "/api/weather") {
      res.setHeader("cache-control", "no-store");
      sendJson(res, 200, await weatherCache.get((await loadConfig()).weather));
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

    // Unknown API paths must not fall through to the SPA's index.html.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    await serveStatic(req, res, url.pathname);
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

// `docker stop` sends SIGTERM, which Node as PID 1 ignores unless it is handled.
// Stop accepting connections, let in-flight requests finish, and exit after a
// grace period at the latest. A second signal uses the default and kills at once.
const SHUTDOWN_GRACE_MS = 5000;
function shutdown(signal: NodeJS.Signals) {
  logEvent("info", "server.stopping", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

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
