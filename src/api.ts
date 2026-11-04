import type {
  ContainersAllResponse,
  ContainersResponse,
  HomieConfig,
  PingResult,
  RemoteContainersResponse,
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

export async function fetchContainers(): Promise<ContainersResponse> {
  const res = await fetch("/api/containers");
  if (!res.ok) throw new Error(`failed to load containers: ${res.status}`);
  return res.json();
}

export async function fetchAllContainers(): Promise<ContainersAllResponse> {
  const res = await fetch("/api/containers/all");
  if (!res.ok) throw new Error(`failed to load containers: ${res.status}`);
  return res.json();
}

export async function fetchRemoteContainers(): Promise<RemoteContainersResponse> {
  const res = await fetch("/api/containers/remote");
  if (!res.ok) throw new Error(`failed to load remote containers: ${res.status}`);
  return res.json();
}

export async function fetchPing(url: string): Promise<PingResult> {
  const res = await fetch(`/api/ping?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`ping failed: ${res.status}`);
  return res.json();
}
