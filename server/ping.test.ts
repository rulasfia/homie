import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { pingUrl } from "./ping.ts";

let server: Server;
let base: string;
let dir: string;
const requests: string[] = [];

beforeAll(async () => {
  // Self-signed certificate generated locally; no network access needed.
  dir = mkdtempSync(join(tmpdir(), "homie-ping-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  server = createServer(
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === "/no-head" && req.method === "HEAD") res.writeHead(405).end();
      else if (req.url === "/redirect") res.writeHead(302, { location: "/ok" }).end();
      else if (req.url === "/loop") res.writeHead(302, { location: "/loop" }).end();
      else if (req.url === "/other-host") {
        const { port } = server.address() as AddressInfo;
        res.writeHead(302, { location: `https://localhost:${port}/ok` }).end();
      } else if (req.url === "/missing") res.writeHead(404).end();
      else res.writeHead(200).end("body");
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

it("reports a self-signed certificate as down by default", async () => {
  const result = await pingUrl(`${base}/ok`, 2000, "Proxmox");
  expect(result).toMatchObject({ ok: false, status: null });
});

it("reports a self-signed certificate as up with insecure", async () => {
  const result = await pingUrl(`${base}/ok`, 2000, "Proxmox", true);
  expect(result).toMatchObject({ ok: true, status: 200 });
});

it("does not leak insecure to later normal pings", async () => {
  expect(await pingUrl(`${base}/ok`, 2000, "Proxmox", true)).toMatchObject({ ok: true });
  expect(await pingUrl(`${base}/ok`, 2000, "Proxmox")).toMatchObject({ ok: false, status: null });
  expect(await pingUrl(`${base}/ok`, 2000, "Proxmox", false)).toMatchObject({
    ok: false,
    status: null,
  });
});

it("keeps the insecure status rule, HEAD fallback and redirects", async () => {
  requests.length = 0;
  expect(await pingUrl(`${base}/missing`, 2000, "x", true)).toMatchObject({
    ok: false,
    status: 404,
  });
  expect(await pingUrl(`${base}/no-head`, 2000, "x", true)).toMatchObject({
    ok: true,
    status: 200,
  });
  expect(await pingUrl(`${base}/redirect`, 2000, "x", true)).toMatchObject({
    ok: true,
    status: 200,
  });
  expect(requests).toEqual([
    "HEAD /missing",
    "HEAD /no-head",
    "GET /no-head",
    "HEAD /redirect",
    "HEAD /ok",
  ]);
});

it("gives up on insecure redirect loops", async () => {
  const result = await pingUrl(`${base}/loop`, 2000, "x", true);
  expect(result).toMatchObject({ ok: false, status: null, error: "too many redirects" });
});

it("does not extend insecure to redirects to another host", async () => {
  // localhost is a different host than 127.0.0.1, so its certificate is verified.
  const result = await pingUrl(`${base}/other-host`, 2000, "x", true);
  expect(result).toMatchObject({ ok: false, status: null });
});

it("times out insecure pings", async () => {
  const stalled = createServer({
    key: readFileSync(join(dir, "key.pem")),
    cert: readFileSync(join(dir, "cert.pem")),
  });
  await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  try {
    const url = `https://127.0.0.1:${(stalled.address() as AddressInfo).port}/`;
    const result = await pingUrl(url, 100, "x", true);
    expect(result).toMatchObject({ ok: false, status: null });
  } finally {
    stalled.closeAllConnections();
    stalled.close();
  }
});
