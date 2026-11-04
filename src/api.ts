import type {
  ContainersAllResponse,
  HomieConfig,
  PingResult,
  SystemsResponse,
} from "../shared/types.ts";

export async function fetchConfig(): Promise<HomieConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
    ) {
      throw new Error(body.error);
    }
    throw new Error(`failed to load config: ${res.status}`);
  }
  return res.json();
}

export async function fetchSystems(): Promise<SystemsResponse> {
  const res = await fetch("/api/systems");
  if (!res.ok) throw new Error(`failed to load systems: ${res.status}`);
  return res.json();
}

export async function fetchAllContainers(): Promise<ContainersAllResponse> {
  const res = await fetch("/api/containers/all");
  if (!res.ok) throw new Error(`failed to load containers: ${res.status}`);
  return res.json();
}

export type StreamedPing = PingResult & { url: string };

/**
 * Requests `/api/pings` and calls `onResult` for each NDJSON line as it
 * arrives (a line may span chunks). Resolves once the server ends the stream;
 * rejects on an HTTP error, a broken connection, or a malformed line.
 */
export async function fetchPings(onResult: (result: StreamedPing) => void) {
  const res = await fetch("/api/pings");
  if (!res.ok || !res.body) throw new Error(`pings failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      // The last piece is a partial line until the stream is done.
      pending = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (line.trim()) onResult(JSON.parse(line) as StreamedPing);
      }
      if (done) return;
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
}
