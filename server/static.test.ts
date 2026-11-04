import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { serveStatic } from "./static.ts";

const bigText = (label: string) => `${label} ${"lorem ipsum ".repeat(300)}`;
const SECRET = "top secret";

let base: string;
let root: string;

beforeAll(async () => {
  // <base>/secret.txt sits next to <base>/dist, where traversal would land.
  base = await mkdtemp(join(tmpdir(), "homie-static-"));
  root = join(base, "dist");
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "icons"), { recursive: true });
  await writeFile(join(base, "secret.txt"), SECRET);
  await writeFile(join(root, "index.html"), bigText("<html>shell"));
  await writeFile(join(root, "sw.js"), bigText("sw"));
  await writeFile(join(root, "manifest.json"), bigText("manifest"));
  await writeFile(join(root, "offline.html"), bigText("offline"));
  await writeFile(join(root, "favicon.svg"), bigText("<svg>"));
  await writeFile(join(root, "tiny.css"), "a{}");
  await writeFile(join(root, "assets", "app-abc123.js"), bigText("bundle"));
  await writeFile(join(root, "icons", "icon.png"), Buffer.alloc(2048, 1));
});

afterAll(() => rm(base, { recursive: true, force: true }));

async function get(pathname: string, headers: Record<string, string> = {}, method = "GET") {
  const res = {
    status: 0,
    headers: {} as Record<string, string | number>,
    body: Buffer.alloc(0),
    writeHead(status: number, h: Record<string, string | number> = {}) {
      res.status = status;
      res.headers = h;
      return res;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) res.body = Buffer.from(chunk);
      return res;
    },
  };
  await serveStatic({ method, headers }, res as unknown as ServerResponse, pathname, root);
  return res;
}

it.each([
  ["/assets/app-abc123.js", "public, max-age=31536000, immutable"],
  ["/", "no-cache"],
  ["/index.html", "no-cache"],
  ["/sw.js", "no-cache"],
  ["/manifest.json", "no-cache"],
  ["/offline.html", "no-cache"],
  ["/some/spa/route", "no-cache"], // index.html fallback
  ["/favicon.svg", "public, max-age=3600"],
  ["/icons/icon.png", "public, max-age=3600"],
])("sets cache-control for %s", async (path, cacheControl) => {
  const res = await get(path);
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe(cacheControl);
});

it("serves unknown page paths as index.html", async () => {
  const res = await get("/settings/profile");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(res.body.toString()).toBe(bigText("<html>shell"));
});

it("returns 404, not index.html, for a missing asset", async () => {
  const res = await get("/assets/missing-abc.js");
  expect(res.status).toBe(404);
  expect(res.body.toString()).not.toContain("<html>");
});

it("returns 304 for a matching If-None-Match and 200 for a stale one", async () => {
  for (const path of ["/", "/sw.js", "/manifest.json", "/offline.html"]) {
    const first = await get(path);
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^"[\w-]+"$/);

    const hit = await get(path, { "if-none-match": etag });
    expect(hit.status).toBe(304);
    expect(hit.headers["cache-control"]).toBe("no-cache");
    expect(hit.body.length).toBe(0);

    expect((await get(path, { "if-none-match": `W/${etag}, "other"` })).status).toBe(304);
    expect((await get(path, { "if-none-match": '"stale"' })).status).toBe(200);
  }
});

it("keeps a separate ETag per encoding", async () => {
  const plain = await get("/sw.js");
  const br = await get("/sw.js", { "accept-encoding": "br" });
  expect(br.headers.etag).not.toBe(plain.headers.etag);
  // A validator from the identity response must not validate a brotli response.
  const res = await get("/sw.js", {
    "accept-encoding": "br",
    "if-none-match": String(plain.headers.etag),
  });
  expect(res.status).toBe(200);
});

it("chooses brotli, gzip or identity from Accept-Encoding", async () => {
  const original = bigText("bundle");
  const path = "/assets/app-abc123.js";

  const br = await get(path, { "accept-encoding": "gzip, deflate, br" });
  expect(br.headers["content-encoding"]).toBe("br");
  expect(brotliDecompressSync(br.body).toString()).toBe(original);
  expect(br.headers["content-length"]).toBe(br.body.length);
  expect(br.body.length).toBeLessThan(original.length);

  const gz = await get(path, { "accept-encoding": "gzip, deflate" });
  expect(gz.headers["content-encoding"]).toBe("gzip");
  expect(gunzipSync(gz.body).toString()).toBe(original);

  const gzWhenBrRefused = await get(path, { "accept-encoding": "br;q=0, gzip" });
  expect(gzWhenBrRefused.headers["content-encoding"]).toBe("gzip");

  for (const header of [undefined, "identity"]) {
    const plain = await get(path, header ? { "accept-encoding": header } : {});
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body.toString()).toBe(original);
  }

  for (const res of [br, gz]) expect(res.headers.vary).toBe("Accept-Encoding");
});

it("does not compress binary or tiny files", async () => {
  for (const path of ["/icons/icon.png", "/tiny.css"]) {
    const res = await get(path, { "accept-encoding": "br, gzip" });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers.vary).toBeUndefined();
  }
});

it("reuses the compressed bytes across requests", async () => {
  const a = await get("/favicon.svg", { "accept-encoding": "br" });
  const b = await get("/favicon.svg", { "accept-encoding": "br" });
  expect(a.body.equals(b.body)).toBe(true);
});

it("sends headers but no body for HEAD", async () => {
  const res = await get("/assets/app-abc123.js", {}, "HEAD");
  expect(res.status).toBe(200);
  expect(res.body.length).toBe(0);
  expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
});

it.each([
  "/../secret.txt",
  "/..%2fsecret.txt",
  "/..%2F..%2Fetc/passwd",
  "/%2e%2e/secret.txt",
  "/%2e%2e%2fsecret.txt",
  "/assets/..%2f..%2fsecret.txt",
  "/%00",
  "/%",
])("blocks traversal and bad escapes: %s", async (path) => {
  const res = await get(path);
  expect(res.status).toBe(404);
  expect(res.body.toString()).not.toContain(SECRET);
});

it("treats a backslash as a plain filename character, not a separator", async () => {
  const res = await get("/..%5csecret.txt");
  expect(res.body.toString()).not.toContain(SECRET);
});

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

it("sends the CSP and X-Frame-Options on HTML only", async () => {
  for (const path of ["/", "/offline.html", "/some/spa/route"]) {
    const res = await get(path);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    const csp = String(res.headers["content-security-policy"]);
    for (const directive of [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' https: http: data:",
      "style-src-attr 'unsafe-inline'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp.split("; ")).toContain(directive);
    }
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  }
  // 304s carry the policy too.
  const etag = String((await get("/")).headers.etag);
  expect(
    (await get("/", { "if-none-match": etag })).headers["content-security-policy"],
  ).toBeDefined();

  for (const path of ["/sw.js", "/manifest.json", "/favicon.svg", "/assets/app-abc123.js"]) {
    const res = await get(path);
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["x-frame-options"]).toBeUndefined();
  }
});

it("hashes each inline script and style from the served bytes, skipping external scripts", async () => {
  const inlineRoot = join(base, "inline");
  await mkdir(inlineRoot);
  const script = "\n  document.documentElement.dataset.theme = 'dark';\n";
  const style = "body { margin: 0 }";
  const page = (js: string) =>
    `<!doctype html><script>${js}</script><style>${style}</style>` +
    '<script type="module" src="/src/main.ts"></script><script src="/x.js">ignored</script>';

  await writeFile(join(inlineRoot, "index.html"), page(script));
  const first = await serveWith(inlineRoot);
  const csp = first.split("; ");
  expect(csp).toContain(`script-src 'self' ${sha256(script)}`);
  expect(csp).toContain(`style-src 'self' ${sha256(style)}`);

  // A different file is a different cache entry, so its hash follows its script.
  const changedRoot = join(base, "changed");
  await mkdir(changedRoot);
  await writeFile(join(changedRoot, "index.html"), page(`${script}// edited\n`));
  expect(await serveWith(changedRoot)).toContain(sha256(`${script}// edited\n`));
  expect(await serveWith(changedRoot)).not.toContain(sha256(script));
});

it("adds no hash for a page without inline scripts", async () => {
  const csp = String((await get("/")).headers["content-security-policy"]);
  expect(csp).toContain("script-src 'self';");
  expect(csp).toContain("style-src 'self'");
  expect(csp).not.toContain("sha256-");
});

async function serveWith(dir: string) {
  const res = {
    headers: {} as Record<string, string | number>,
    writeHead(_status: number, h: Record<string, string | number>) {
      res.headers = h;
      return res;
    },
    end() {},
  };
  await serveStatic({ method: "GET", headers: {} }, res as unknown as ServerResponse, "/", dir);
  return String(res.headers["content-security-policy"]);
}
