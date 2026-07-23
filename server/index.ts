import { createServer, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import type { UnifiedContainer } from "../shared/types.ts";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { loadConfig, bookmarkUrls } from "./config.ts";
import { pingUrl } from "./ping.ts";
import { beszelConfigured, getRemoteContainers, getSystems } from "./beszel.ts";
import { dockerConfigured, getContainers } from "./docker.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DIST_DIR = join(import.meta.dirname, "..", "dist");

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
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

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
      sendJson(res, 200, await pingUrl(target, config.pingTimeoutMs));
      return;
    }

    if (url.pathname === "/api/systems") {
      if (!beszelConfigured()) {
        sendJson(res, 200, { configured: false, systems: [] });
        return;
      }
      try {
        sendJson(res, 200, { configured: true, systems: await getSystems() });
      } catch (err) {
        console.error("beszel:", err instanceof Error ? err.message : err);
        sendJson(res, 502, { configured: true, systems: [], error: "beszel unreachable" });
      }
      return;
    }

    if (url.pathname === "/api/containers") {
      if (!dockerConfigured()) {
        sendJson(res, 200, { configured: false, containers: [] });
        return;
      }
      try {
        sendJson(res, 200, { configured: true, containers: await getContainers() });
      } catch (err) {
        console.error("docker:", err instanceof Error ? err.message : err);
        sendJson(res, 502, { configured: true, containers: [], error: "docker unreachable" });
      }
      return;
    }

    if (url.pathname === "/api/containers/all") {
      const hasDocker = dockerConfigured();
      const hasBeszel = beszelConfigured();
      if (!hasDocker && !hasBeszel) {
        sendJson(res, 200, { configured: false, sources: [], containers: [] });
        return;
      }

      try {
        const localContainers: UnifiedContainer[] = hasDocker
          ? (await getContainers()).map((c) => ({ ...c, source: "local", systemName: "local" }))
          : [];

        const remoteResponse = hasBeszel ? await getRemoteContainers() : { bySystem: [] };
        const remoteContainers: UnifiedContainer[] = remoteResponse.bySystem.flatMap((group) =>
          group.containers.map((c) => ({
            name: c.name,
            state: group.systemStatus === "up" ? "running" : "unknown",
            source: "remote" as const,
            systemId: group.systemId,
            systemName: group.systemName,
            cpuPct: c.cpuPct,
            memPct: c.memPct,
            netBytes: c.netBytes,
          })),
        );

        const containers = [...localContainers, ...remoteContainers].sort((a, b) =>
          a.name.localeCompare(b.name),
        );

        const sources = [
          { id: "local", name: hostname() },
          ...remoteResponse.bySystem.map((group) => ({
            id: group.systemId,
            name: group.systemName,
          })),
        ];

        sendJson(res, 200, { configured: true, sources, containers });
      } catch (err) {
        console.error("containers/all:", err instanceof Error ? err.message : err);
        sendJson(res, 502, {
          configured: true,
          sources: [],
          containers: [],
          error: "containers unreachable",
        });
      }
      return;
    }

    if (url.pathname === "/api/containers/remote") {
      if (!beszelConfigured()) {
        sendJson(res, 200, { configured: false, bySystem: [] });
        return;
      }
      try {
        sendJson(res, 200, await getRemoteContainers());
      } catch (err) {
        console.error("beszel remote containers:", err instanceof Error ? err.message : err);
        sendJson(res, 502, { configured: true, bySystem: [], error: "beszel unreachable" });
      }
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: "internal error" });
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `port ${PORT} already in use` : err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`homie listening on http://localhost:${PORT}`);
});
