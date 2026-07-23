import type { PingResult } from "../shared/types.ts";

/**
 * Checks whether a URL is reachable via HTTP HEAD (falling back to GET
 * for servers that don't support HEAD). Any response below 400 counts
 * as "up" — the point is reachability, not correctness of content.
 */
export async function pingUrl(url: string, timeoutMs = 5000): Promise<PingResult> {
  const start = performance.now();
  const latency = () => Math.round(performance.now() - start);

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    let res = await fetch(url, { method: "HEAD", redirect: "follow", signal });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: "GET", redirect: "follow", signal });
    }
    await res.body?.cancel();
    return { ok: res.status < 400, status: res.status, latencyMs: latency() };
  } catch (err) {
    return {
      ok: false,
      status: null,
      latencyMs: latency(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
