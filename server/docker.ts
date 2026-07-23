import { existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { ContainerInfo } from "../shared/types.ts";

const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";
const SOCKET_PATH = process.env.DOCKER_SOCKET ?? DEFAULT_SOCKET_PATH;
const REQUEST_TIMEOUT_MS = 5000;

interface RequestTarget {
  /** When set, requests are made over this unix socket. */
  socketPath?: string;
  /** HTTP(S) target used when no unix socket is configured. */
  protocol: "http:" | "https:";
  host: string;
  port: string | number;
}

export function dockerConfigured(): boolean {
  if (process.env.DOCKER_HOST) {
    return (
      process.env.DOCKER_HOST.startsWith("tcp://") ||
      process.env.DOCKER_HOST.startsWith("http://") ||
      process.env.DOCKER_HOST.startsWith("https://") ||
      (process.env.DOCKER_HOST.startsWith("unix://") &&
        existsSync(process.env.DOCKER_HOST.slice(7) || DEFAULT_SOCKET_PATH))
    );
  }
  return existsSync(SOCKET_PATH);
}

function parseDockerHost(): RequestTarget {
  const dockerHost = process.env.DOCKER_HOST ?? "";

  if (dockerHost.startsWith("unix://")) {
    return {
      socketPath: dockerHost.slice(7) || SOCKET_PATH,
      protocol: "http:",
      host: "localhost",
      port: "",
    };
  }

  if (
    dockerHost.startsWith("tcp://") ||
    dockerHost.startsWith("http://") ||
    dockerHost.startsWith("https://")
  ) {
    const url = new URL(dockerHost);
    return {
      protocol: url.protocol as "http:" | "https:",
      host: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
    };
  }

  return {
    socketPath: SOCKET_PATH,
    protocol: "http:",
    host: "localhost",
    port: "",
  };
}

interface DockerPort {
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

interface DockerContainer {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Ports: DockerPort[];
}

/** Minimal GET against the Docker Engine API. */
function dockerGet(path: string): Promise<string> {
  const target = parseDockerHost();
  const options: http.RequestOptions = { path };

  if (target.socketPath) {
    options.socketPath = target.socketPath;
  } else {
    options.host = target.host;
    options.port = target.port;
  }

  const request = target.protocol === "https:" ? https.get : http.get;

  return new Promise((resolve, reject) => {
    const req = request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode < 300) resolve(body);
        else reject(new Error(`docker api: ${res.statusCode}`));
      });
    });
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("docker socket timeout")));
  });
}

export async function getContainers(): Promise<ContainerInfo[]> {
  const raw = JSON.parse(await dockerGet("/containers/json?all=true")) as DockerContainer[];

  return raw
    .map((c) => ({
      id: c.Id.slice(0, 12),
      name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: [
        ...new Set(
          c.Ports.filter((p) => p.PublicPort).map((p) => `${p.PublicPort}:${p.PrivatePort}`),
        ),
      ],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
