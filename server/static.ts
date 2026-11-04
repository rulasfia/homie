import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";

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

const COMPRESSIBLE_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".svg"]);
// Below this, compression saves too little to be worth the extra header and CPU.
const MIN_COMPRESS_BYTES = 1024;

// Files that must be revalidated on every load: they are not content-hashed, and
// a stale shell, service worker or manifest would pin clients to an old build.
const REVALIDATE_FILES = new Set(["index.html", "sw.js", "manifest.json", "offline.html"]);
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
const SHORT = "public, max-age=3600";

// Directives that never change. Inline scripts and styles are added per document.
// Bookmark icons can be any absolute URL (CDNs, LAN hosts over http), hence img-src.
// Inline `style="..."` attributes are used by the dashboard (meter widths, skeletons).
const CSP_BASE = [
  "default-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "img-src 'self' https: http: data:",
  "style-src-attr 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
];

const INLINE_BLOCK = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

/**
 * Content-Security-Policy for an HTML document: the base policy plus a sha256
 * source for each inline `<script>` and `<style>` block, hashed from the exact
 * bytes being served. A document without inline blocks gets no hash sources.
 */
export function contentSecurityPolicy(html: string): string {
  const hashes = { script: [] as string[], style: [] as string[] };
  for (const [, tag, attributes, content] of html.matchAll(INLINE_BLOCK)) {
    if (tag === "script" && /\ssrc\s*=/i.test(attributes!)) continue;
    const hash = createHash("sha256").update(content!).digest("base64");
    hashes[tag!.toLowerCase() as "script" | "style"].push(`'sha256-${hash}'`);
  }
  const sources = (kind: "script" | "style") => ["'self'", ...hashes[kind]].join(" ");
  return [...CSP_BASE, `script-src ${sources("script")}`, `style-src ${sources("style")}`].join(
    "; ",
  );
}

type Encoding = "br" | "gzip";
const compressors = { br: promisify(brotliCompress), gzip: promisify(gzip) };

type Entry = {
  body: Buffer;
  type: string;
  cacheControl: string;
  revalidate: boolean;
  compressible: boolean;
  etag: string;
  /** Content-Security-Policy, only for HTML documents. */
  csp?: string;
  /** Compressed bytes per encoding, shared by concurrent first requests. */
  variants: Map<Encoding, Promise<Buffer>>;
};

// `dist/` does not change while the server runs, so a file is read, hashed and
// compressed once. Only files that exist are stored, so it is bounded by dist's size.
const entries = new Map<string, Entry>();

async function loadEntry(root: string, file: string): Promise<Entry | null> {
  const known = entries.get(file);
  if (known) return known;

  // Also null for directories (EISDIR) and other unreadable paths.
  const body = await readFile(file).catch(() => null);
  if (body === null) return null;

  const rel = relative(root, file).split(sep).join("/");
  const extension = extname(file);
  const revalidate = REVALIDATE_FILES.has(rel);
  const entry: Entry = {
    body,
    type: MIME_TYPES[extension] ?? "application/octet-stream",
    cacheControl: rel.startsWith("assets/") ? IMMUTABLE : revalidate ? REVALIDATE : SHORT,
    revalidate,
    compressible: COMPRESSIBLE_EXTENSIONS.has(extension) && body.length >= MIN_COMPRESS_BYTES,
    etag: createHash("sha256").update(body).digest("base64url").slice(0, 22),
    variants: new Map(),
  };
  if (extension === ".html") entry.csp = contentSecurityPolicy(body.toString("utf8"));
  entries.set(file, entry);
  return entry;
}

/** Brotli if the client accepts it, then gzip. Honors `q=0` opt-outs. */
function pickEncoding(acceptEncoding: string | undefined): Encoding | null {
  const accepted = new Set<string>();
  for (const part of (acceptEncoding ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (name && !(q !== undefined && Number(q.slice(2)) === 0)) accepted.add(name);
  }
  return accepted.has("br") ? "br" : accepted.has("gzip") ? "gzip" : null;
}

function compressed(entry: Entry, encoding: Encoding): Promise<Buffer> {
  let variant = entry.variants.get(encoding);
  if (!variant) {
    variant = compressors[encoding](entry.body);
    entry.variants.set(encoding, variant);
    // Do not cache a failure; the next request retries.
    variant.catch(() => entry.variants.delete(encoding));
  }
  return variant;
}

function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === "*" || tag === etag);
}

function notFound(res: ServerResponse, message = "not found") {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(message);
}

/**
 * Serve `pathname` (a URL path) from `root`, defaulting to the Vite build output.
 *
 * - `/assets/*` is content-hashed: immutable, and a missing file is a 404, since
 *   index.html cached forever under a JS URL would stick.
 * - index.html, sw.js, manifest.json and offline.html use `no-cache` with an ETag.
 * - Other paths without a file get index.html (SPA fallback).
 * - HTML documents carry a Content-Security-Policy hashed from their inline blocks.
 * - Text types are brotli or gzip compressed per `Accept-Encoding`.
 * - Paths that resolve outside `root` (including encoded `..%2f`) get a 404.
 */
export async function serveStatic(
  req: Pick<IncomingMessage, "method" | "headers">,
  res: ServerResponse,
  pathname: string,
  root = DIST_DIR,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return notFound(res);
  }
  if (decoded.includes("\0")) return notFound(res);

  const distRoot = resolve(root);
  const file = resolve(distRoot, `.${decoded}`);
  if (file !== distRoot && !file.startsWith(distRoot + sep)) return notFound(res);

  let entry = await loadEntry(distRoot, file);
  if (entry === null) {
    if (decoded.startsWith("/assets/")) return notFound(res);
    entry = await loadEntry(distRoot, join(distRoot, "index.html"));
    if (entry === null) return notFound(res, "not found — run `vp build` first");
  }

  const encoding = entry.compressible ? pickEncoding(req.headers["accept-encoding"]) : null;
  const headers: Record<string, string | number> = {
    "content-type": entry.type,
    "cache-control": entry.cacheControl,
  };
  if (entry.csp !== undefined) {
    headers["content-security-policy"] = entry.csp;
    headers["x-frame-options"] = "DENY";
  }
  if (entry.compressible) headers.vary = "Accept-Encoding";
  if (entry.revalidate) {
    // Each encoding is a different representation, so it gets its own ETag.
    headers.etag = `"${entry.etag}${encoding ? `-${encoding}` : ""}"`;
    if (matchesEtag(req.headers["if-none-match"], headers.etag)) {
      res.writeHead(304, headers).end();
      return;
    }
  }

  const body = encoding ? await compressed(entry, encoding) : entry.body;
  if (encoding) headers["content-encoding"] = encoding;
  headers["content-length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}
