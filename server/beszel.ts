import type {
  RemoteContainer,
  RemoteContainersResponse,
  RemoteSystemContainers,
  SystemStatus,
} from "../shared/types.ts";

const { BESZEL_URL, BESZEL_EMAIL, BESZEL_PASSWORD } = process.env;

export function beszelConfigured(): boolean {
  return Boolean(BESZEL_URL && BESZEL_EMAIL && BESZEL_PASSWORD);
}

// PocketBase user tokens are long-lived; cache and re-auth only on 401.
let cachedToken: string | null = null;

async function authenticate(): Promise<string> {
  const res = await fetch(`${BESZEL_URL}/api/collections/users/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: BESZEL_EMAIL, password: BESZEL_PASSWORD }),
  });
  if (!res.ok) throw new Error(`beszel auth failed: ${res.status}`);
  const data = (await res.json()) as { token: string };
  cachedToken = data.token;
  return data.token;
}

interface BeszelSystemRecord {
  id: string;
  name: string;
  host: string;
  status: string;
  info: Record<string, unknown>;
}

interface BeszelDetailsRecord {
  id: string;
  system: string;
  cores?: number;
  threads?: number;
  cpu?: string;
  memory?: number;
  os_name?: string;
  arch?: string;
}

async function fetchSystemRecords(token: string): Promise<BeszelSystemRecord[]> {
  const res = await fetch(
    `${BESZEL_URL}/api/collections/systems/records?perPage=200&fields=id,name,host,status,info`,
    { headers: { authorization: token } },
  );
  if (!res.ok) {
    throw Object.assign(new Error(`beszel systems failed: ${res.status}`), {
      httpStatus: res.status,
    });
  }
  const data = (await res.json()) as { items: BeszelSystemRecord[] };
  return data.items;
}

async function fetchSystemDetails(token: string): Promise<Map<string, BeszelDetailsRecord>> {
  const res = await fetch(
    `${BESZEL_URL}/api/collections/system_details/records?perPage=200&fields=system,cores,threads,cpu,memory,os_name,arch`,
    { headers: { authorization: token } },
  );
  if (!res.ok) {
    // system_details is a newer collection; ignore failures and fall back to info fields.
    return new Map();
  }
  const data = (await res.json()) as { items: BeszelDetailsRecord[] };
  const map = new Map<string, BeszelDetailsRecord>();
  for (const item of data.items) {
    map.set(item.system, item);
  }
  return map;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Maps Beszel's compact `info` field names to our SystemStatus shape. */
function normalize(record: BeszelSystemRecord, details?: BeszelDetailsRecord): SystemStatus {
  const info = record.info ?? {};
  const osName = str(details?.os_name) ?? str(info.o) ?? str(info.k);
  return {
    id: record.id,
    name: record.name,
    host: record.host,
    status: record.status,
    uptime: num(info.u),
    cpu: num(info.cpu),
    memPct: num(info.mp),
    diskPct: num(info.dp),
    loadAvg: Array.isArray(info.la) ? (info.la as [number, number, number]) : undefined,
    temp: typeof info.dt === "number" ? info.dt : undefined,
    agentVersion: typeof info.v === "string" ? info.v : "",
    specs: {
      cpuModel: str(details?.cpu) ?? str(info.m),
      cores: typeof details?.cores === "number" ? details.cores : num(info.c) || undefined,
      threads: typeof details?.threads === "number" ? details.threads : num(info.t) || undefined,
      memoryTotalBytes: typeof details?.memory === "number" ? details.memory : undefined,
      osName,
      arch: str(details?.arch),
    },
  };
}

export async function getSystems(): Promise<SystemStatus[]> {
  let token = cachedToken ?? (await authenticate());
  try {
    const records = await fetchSystemRecords(token);
    const details = await fetchSystemDetails(token);
    return records.map((record) => normalize(record, details.get(record.id)));
  } catch (err) {
    if ((err as { httpStatus?: number }).httpStatus !== 401) throw err;
    cachedToken = null;
    token = await authenticate();
    const records = await fetchSystemRecords(token);
    const details = await fetchSystemDetails(token);
    return records.map((record) => normalize(record, details.get(record.id)));
  }
}

interface BeszelContainerStatsRecord {
  id: string;
  system: string;
  created: string;
  stats: unknown[];
}

interface BeszelCompactContainerStat {
  /** Container name */
  n: string;
  /** CPU percent */
  c?: number;
  /** Memory percent */
  m?: number;
  /** Network I/O bytes */
  b?: number;
}

function isCompactStat(value: unknown): value is BeszelCompactContainerStat {
  return (
    typeof value === "object" &&
    value !== null &&
    "n" in value &&
    typeof (value as Record<string, unknown>).n === "string"
  );
}

async function fetchContainerStats(
  token: string,
  systemId: string,
): Promise<BeszelContainerStatsRecord | null> {
  const params = new URLSearchParams({
    filter: `system='${systemId}'`,
    sort: "-created",
    perPage: "1",
    fields: "id,system,created,stats",
  });
  const res = await fetch(
    `${BESZEL_URL}/api/collections/container_stats/records?${params.toString()}`,
    { headers: { authorization: token } },
  );
  if (!res.ok) {
    // Some older Beszel hubs may not have this collection; ignore per-system failures.
    return null;
  }
  const data = (await res.json()) as { items: BeszelContainerStatsRecord[] };
  return data.items[0] ?? null;
}

function normalizeRemoteContainer(stat: BeszelCompactContainerStat): RemoteContainer {
  return {
    name: stat.n,
    cpuPct: typeof stat.c === "number" ? stat.c : undefined,
    memPct: typeof stat.m === "number" ? stat.m : undefined,
    netBytes: typeof stat.b === "number" ? stat.b : undefined,
  };
}

export async function getRemoteContainers(): Promise<RemoteContainersResponse> {
  let token = cachedToken ?? (await authenticate());
  let records: BeszelSystemRecord[];
  try {
    records = await fetchSystemRecords(token);
  } catch (err) {
    if ((err as { httpStatus?: number }).httpStatus !== 401) throw err;
    cachedToken = null;
    token = await authenticate();
    records = await fetchSystemRecords(token);
  }

  const systemsWithContainers = await Promise.all(
    records.map(async (record) => {
      const statsRecord = await fetchContainerStats(token, record.id);
      const stats = Array.isArray(statsRecord?.stats) ? statsRecord.stats : [];
      const containers = stats
        .filter((stat): stat is BeszelCompactContainerStat => isCompactStat(stat))
        .map(normalizeRemoteContainer)
        .sort((a, b) => a.name.localeCompare(b.name));

      const group: RemoteSystemContainers = {
        systemId: record.id,
        systemName: record.name,
        systemHost: record.host,
        systemStatus: record.status,
        containers,
      };
      return group;
    }),
  );

  const bySystem = systemsWithContainers.filter((group) => group.containers.length > 0);
  return { configured: true, bySystem };
}
