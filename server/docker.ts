import { existsSync } from "node:fs";
import http from "node:http";
import type { ContainerInfo } from "../shared/types.ts";

const SOCKET_PATH = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const REQUEST_TIMEOUT_MS = 5000;

export function dockerConfigured(): boolean {
  return existsSync(SOCKET_PATH);
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

/** Minimal GET against the Docker Engine API over the unix socket. */
function dockerGet(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: SOCKET_PATH, path }, (res) => {
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
