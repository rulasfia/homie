import { Agent, request } from "node:https";
import type { PingResult } from "../shared/types.ts";
import { errorDetails, reportHealth, safeTarget } from "./log.ts";

/**
 * Self-signed bookmarks (`insecure: true`) use node:https with a dedicated
 * agent instead of the undici `dispatcher` fetch option: that option is
 * non-standard and needs the `undici` package as a production dependency
 * matching Node's bundled copy, while this path is small and dependency-free.
 * The agent is shared, module-private, and never used by any other request, so
 * verification stays on everywhere else (other bookmarks, Beszel, Docker).
 */
const insecureAgent = new Agent({ rejectUnauthorized: false });
const MAX_INSECURE_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function insecureRequest(url: URL, method: string, signal: AbortSignal) {
  return new Promise<{ status: number; location?: string }>((resolve, reject) => {
    const req = request(url, { method, agent: insecureAgent, signal }, (res) => {
      resolve({ status: res.statusCode ?? 0, location: res.headers.location });
      res.destroy(); // discard the body
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchStatus(url: string, method: string, signal: AbortSignal): Promise<number> {
  const res = await fetch(url, { method, redirect: "follow", signal });
  await res.body?.cancel();
  return res.status;
}

/**
 * Returns the final HTTP status. With `insecure`, certificate errors are
 * ignored only for the configured host: redirects are followed manually and
 * any hop to another host (or to plain http) falls back to a verified fetch.
 */
async function requestStatus(
  url: string,
  method: string,
  signal: AbortSignal,
  insecure: boolean,
): Promise<number> {
  const origin = new URL(url);
  if (!insecure || origin.protocol !== "https:") return fetchStatus(url, method, signal);

  let current = origin;
  for (let redirects = 0; ; redirects++) {
    if (current.protocol !== "https:" || current.host !== origin.host) {
      return fetchStatus(current.href, method, signal);
    }
    const { status, location } = await insecureRequest(current, method, signal);
    if (!REDIRECT_STATUSES.has(status) || !location) return status;
    if (redirects >= MAX_INSECURE_REDIRECTS) throw new Error("too many redirects");
    current = new URL(location, current);
  }
}

/**
 * Checks whether a URL is reachable via HTTP HEAD (falling back to GET
 * for servers that don't support HEAD). Any response below 400 counts
 * as "up" — the point is reachability, not correctness of content.
 * `insecure` skips TLS certificate verification for this URL only.
 */
export async function pingUrl(
  url: string,
  timeoutMs = 5000,
  name?: string,
  insecure = false,
): Promise<PingResult> {
  const start = performance.now();
  const latency = () => Math.round(performance.now() - start);
  const fields = { bookmark: name, target: safeTarget(url), timeoutMs };

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    let status = await requestStatus(url, "HEAD", signal, insecure);
    if (status === 405 || status === 501) {
      status = await requestStatus(url, "GET", signal, insecure);
    }
    const result = { ok: status < 400, status, latencyMs: latency() };
    reportHealth(`bookmark:${url}`, result.ok, "bookmark.check", {
      ...fields,
      httpStatus: result.status,
      latencyMs: result.latencyMs,
    });
    return result;
  } catch (err) {
    reportHealth(`bookmark:${url}`, false, "bookmark.check", {
      ...fields,
      ...errorDetails(err),
      latencyMs: latency(),
    });
    return {
      ok: false,
      status: null,
      latencyMs: latency(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
