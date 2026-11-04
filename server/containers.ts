import type {
  ContainerInfo,
  ContainerSource,
  ContainersAllResponse,
  RemoteContainersResponse,
  UnifiedContainer,
} from "../shared/types.ts";

const LOCAL_ERROR = "docker unreachable";
const REMOTE_ERROR = "beszel unreachable";

export interface ContainersAllRequest {
  /** Omit when Docker is not configured. */
  local?: {
    name: string;
    load: () => Promise<ContainerInfo[]>;
  };
  /** Omit when Beszel is not configured. */
  remote?: {
    load: () => Promise<RemoteContainersResponse>;
  };
  /** Called for unexpected loader failures; upstream modules already report health. */
  onError?: (source: "local" | "remote", error: unknown) => void;
}

function localUnified(containers: ContainerInfo[]): UnifiedContainer[] {
  return containers.map((container) => ({
    ...container,
    source: "local",
    systemName: "local",
  }));
}

function remoteUnified(bySystem: RemoteContainersResponse["bySystem"]): UnifiedContainer[] {
  return bySystem.flatMap((group) =>
    group.containers.map((container) => ({
      name: container.name,
      state: group.systemStatus === "up" ? "running" : "unknown",
      source: "remote" as const,
      systemId: group.systemId,
      systemName: group.systemName,
      ...(container.cpuPct !== undefined ? { cpuPct: container.cpuPct } : {}),
      ...(container.memBytes !== undefined ? { memBytes: container.memBytes } : {}),
      ...(container.netSentBps !== undefined ? { netSentBps: container.netSentBps } : {}),
      ...(container.netRecvBps !== undefined ? { netRecvBps: container.netRecvBps } : {}),
    })),
  );
}

/** Calls a loader immediately so both sources start together, turning sync throws into rejections. */
function startLoad<T>(load: (() => Promise<T>) | undefined): Promise<T | undefined> {
  try {
    return Promise.resolve(load?.());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Fetches local and remote container sources concurrently and keeps whatever
 * succeeds. Returns HTTP 502 only when every configured source failed.
 */
export async function aggregateContainers({
  local,
  remote,
  onError,
}: ContainersAllRequest): Promise<{ status: number; body: ContainersAllResponse }> {
  if (!local && !remote) {
    return { status: 200, body: { configured: false, sources: [], containers: [] } };
  }

  const [localResult, remoteResult] = await Promise.allSettled([
    startLoad(local?.load),
    startLoad(remote?.load),
  ]);

  const sources: ContainerSource[] = [];
  const containers: UnifiedContainer[] = [];
  let succeeded = false;
  let failed = false;

  if (local) {
    if (localResult.status === "fulfilled" && localResult.value !== undefined) {
      succeeded = true;
      sources.push({ id: "local", name: local.name });
      containers.push(...localUnified(localResult.value));
    } else {
      failed = true;
      sources.push({ id: "local", name: local.name, error: LOCAL_ERROR });
      if (localResult.status === "rejected") onError?.("local", localResult.reason);
    }
  }

  if (remote) {
    if (remoteResult.status === "fulfilled" && remoteResult.value !== undefined) {
      const healthyGroups = remoteResult.value.bySystem.filter((group) => !group.error);
      // A reachable hub with no monitored systems is still a successful source.
      if (remoteResult.value.bySystem.length === 0) succeeded = true;

      for (const group of remoteResult.value.bySystem) {
        if (group.error) {
          failed = true;
          sources.push({ id: group.systemId, name: group.systemName, error: group.error });
        } else {
          succeeded = true;
          sources.push({ id: group.systemId, name: group.systemName });
        }
      }
      containers.push(...remoteUnified(healthyGroups));
    } else {
      failed = true;
      sources.push({ id: "beszel", name: "Beszel", error: REMOTE_ERROR });
      if (remoteResult.status === "rejected") onError?.("remote", remoteResult.reason);
    }
  }

  containers.sort((a, b) => a.name.localeCompare(b.name));

  if (!succeeded && failed) {
    return {
      status: 502,
      body: {
        configured: true,
        sources,
        containers: [],
        error: "containers unreachable",
      },
    };
  }

  return {
    status: 200,
    body: {
      configured: true,
      sources,
      containers,
      ...(succeeded && failed ? { partial: true } : {}),
    },
  };
}
