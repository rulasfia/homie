import type {
  ContainersResponse,
  HomieConfig,
  PingResult,
  SystemsResponse,
} from "../shared/types.ts";

export async function fetchConfig(): Promise<HomieConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`failed to load config: ${res.status}`);
  return res.json();
}

export async function fetchSystems(): Promise<SystemsResponse> {
  const res = await fetch("/api/systems");
  if (!res.ok) throw new Error(`failed to load systems: ${res.status}`);
  return res.json();
}

export async function fetchContainers(): Promise<ContainersResponse> {
  const res = await fetch("/api/containers");
  if (!res.ok) throw new Error(`failed to load containers: ${res.status}`);
  return res.json();
}

export async function fetchPing(url: string): Promise<PingResult> {
  const res = await fetch(`/api/ping?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`ping failed: ${res.status}`);
  return res.json();
}
