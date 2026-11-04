/** Fixed origin for relative request targets; the client-controlled Host header is not trusted. */
const REQUEST_BASE = "http://localhost";

/**
 * Parse an HTTP request target for routing. Origin-form targets are resolved
 * against a fixed base so a malformed Host header cannot break parsing.
 * Absolute-form targets (sent by some proxies) are parsed directly and still
 * route by their path and query. Returns null when the target is malformed.
 */
export function parseRequestUrl(requestTarget: string | undefined): URL | null {
  try {
    return new URL(requestTarget ?? "/", REQUEST_BASE);
  } catch {
    return null;
  }
}
