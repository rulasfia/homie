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
    if (redirects >= MAX_INSECURE_REDIRECTS) {
      throw Object.assign(new Error("too many redirects"), { code: "ERR_TOO_MANY_REDIRECTS" });
    }
    current = new URL(location, current);
  }
}

const INSECURE_HINT = "set insecure: true on the bookmark to allow it";

/** Certificate errors that the per-bookmark `insecure` option gets past. */
const INSECURE_FIXABLE = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

const REASONS: Record<string, string> = {
  ECONNREFUSED: "connection refused",
  ENOTFOUND: "DNS lookup failed",
  EAI_AGAIN: "DNS lookup failed",
  ECONNRESET: "connection reset",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
  DEPTH_ZERO_SELF_SIGNED_CERT: "self-signed certificate",
  SELF_SIGNED_CERT_IN_CHAIN: "self-signed certificate in chain",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "unknown certificate issuer",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "unknown certificate issuer",
  CERT_HAS_EXPIRED: "certificate expired",
  ERR_TLS_CERT_ALTNAME_INVALID: "certificate does not match hostname",
};

/**
 * Turns a ping error into a short reason safe to show in the browser. Walks
 * the `cause` chain (fetch wraps the real error in `cause`) and maps known
 * codes and names to fixed phrases. Never returns upstream messages, URLs or
 * other free text; unknown errors fall back to their code or a generic phrase.
 */
export function describeError(err: unknown, timeoutMs: number) {
  let firstCode: string | undefined;
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const { code, name, message, cause } = e as Record<string, unknown>;
    if (name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
      return `timed out after ${timeoutMs}ms`;
    }
    // undici's redirect limit has no code, only this fixed message.
    if (code === "ERR_TOO_MANY_REDIRECTS" || message === "redirect count exceeded") {
      return "too many redirects";
    }
    if (typeof code === "string") {
      const reason = REASONS[code];
      if (reason) {
        const hint = INSECURE_FIXABLE.has(code) ? `, ${INSECURE_HINT}` : "";
        return `${reason} (${code})${hint}`;
      }
      if (!firstCode && /^[A-Z0-9_]{2,64}$/.test(code)) firstCode = code;
    }
    e = cause;
  }
  return firstCode ?? "request failed";
}

/**
 * By default any response below 400, plus 401 and 403, counts as "up": a
 * service behind basic auth or an SSO gateway is reachable. The point is
 * reachability, not correctness of content. When `expectStatus` is given, only
 * statuses in that list count as "up". 404 and 5xx are "down" by default.
 */
export function isUpStatus(status: number, expectStatus?: number[]): boolean {
  if (expectStatus) return expectStatus.includes(status);
  return status < 400 || status === 401 || status === 403;
}

export interface PingOptions {
  /** Statuses that count as "up"; see isUpStatus. */
  expectStatus?: number[];
  /** Skip TLS certificate verification for this URL only. */
  insecure?: boolean;
}

/**
 * Checks whether a URL is reachable via HTTP HEAD (falling back to GET for
 * servers that don't support HEAD), classifying the final status with
 * isUpStatus. Timeouts and network errors are always "down".
 */
export async function pingUrl(
  url: string,
  timeoutMs = 5000,
  name?: string,
  { expectStatus, insecure = false }: PingOptions = {},
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
    const result = { ok: isUpStatus(status, expectStatus), status, latencyMs: latency() };
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
      error: describeError(err, timeoutMs),
    };
  }
}
