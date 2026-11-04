import type {
  RemoteContainer,
  RemoteContainersResponse,
  RemoteSystemContainers,
  SystemStatus,
} from "../shared/types.ts";
import { errorDetails, monitor, reportHealth, safeTarget } from "./log.ts";

const { BESZEL_URL, BESZEL_EMAIL, BESZEL_PASSWORD } = process.env;
const REQUEST_TIMEOUT_MS = 5000;

async function beszelFetch(path: string, operation: string, options: RequestInit = {}) {
  try {
    return await fetch(`${BESZEL_URL}${path}`, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw Object.assign(new Error("Beszel request failed", { cause }), { operation });
  }
}

export function beszelConfigured(): boolean {
  return Boolean(BESZEL_URL && BESZEL_EMAIL && BESZEL_PASSWORD);
}

// PocketBase user tokens are long-lived; cache and re-auth only on 401.
let cachedToken: string | null = null;

async function authenticate(): Promise<string> {
  const res = await beszelFetch("/api/collections/users/auth-with-password", "authenticate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: BESZEL_EMAIL, password: BESZEL_PASSWORD }),
  });
  if (!res.ok)
    throw Object.assign(new Error(`beszel auth failed: ${res.status}`), {
      httpStatus: res.status,
      operation: "authenticate",
    });
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
  const res = await beszelFetch(
    "/api/collections/systems/records?perPage=200&fields=id,name,host,status,info",
    "systems",
    { headers: { authorization: token } },
  );
  if (!res.ok) {
    throw Object.assign(new Error(`beszel systems failed: ${res.status}`), {
      httpStatus: res.status,
      operation: "systems",
    });
  }
  const data = (await res.json()) as { items: BeszelSystemRecord[] };
  for (const record of data.items) {
    // Paused monitoring is intentional, not a connectivity failure.
    if (record.status === "paused") continue;
    reportHealth(`beszel:machine:${record.id}`, record.status === "up", "beszel.machine", {
      machine: record.name,
      systemId: record.id,
      status: record.status,
    });
  }
  return data.items;
}

async function fetchSystemDetails(token: string): Promise<Map<string, BeszelDetailsRecord>> {
  const res = await beszelFetch(
    "/api/collections/system_details/records?perPage=200&fields=system,cores,threads,cpu,memory,os_name,arch",
    "system_details",
    { headers: { authorization: token } },
  );
  reportHealth("beszel:details", res.ok, "beszel.system_details", {
    target: safeTarget(BESZEL_URL),
    httpStatus: res.status,
  });
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

const MEBIBYTE = 1024 * 1024;

/** Returns a finite, non-negative number, or undefined for missing/malformed metrics. */
function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mebibytesToBytes(value: unknown): number | undefined {
  const mebibytes = finiteNonNegative(value);
  if (mebibytes === undefined) return undefined;
  const bytes = mebibytes * MEBIBYTE;
  return Number.isFinite(bytes) ? Math.round(bytes) : undefined;
}

/** Beszel's `b` is [sent, received] bytes per second; keep each valid side independently. */
function networkRates(value: unknown): Pick<RemoteContainer, "netSentBps" | "netRecvBps"> {
  if (!Array.isArray(value) || value.length !== 2) return {};
  const sent = finiteNonNegative(value[0]);
  const recv = finiteNonNegative(value[1]);
  return {
    ...(sent !== undefined ? { netSentBps: sent } : {}),
    ...(recv !== undefined ? { netRecvBps: recv } : {}),
  };
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

async function fetchSystems(): Promise<SystemStatus[]> {
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

export function getSystems() {
  return monitor(
    "beszel:systems",
    "beszel.systems",
    {
      target: safeTarget(BESZEL_URL),
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
    fetchSystems,
  );
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
  /** Memory used, in mebibytes (bytes / 1048576) */
  m?: number;
  /** Network throughput [sent, received], in bytes per second */
  b?: [number, number];
}

function isCompactStat(value: unknown): value is BeszelCompactContainerStat {
  return (
    typeof value === "object" &&
    value !== null &&
    "n" in value &&
    typeof (value as Record<string, unknown>).n === "string"
  );
}

interface ContainerStatsResult {
  record: BeszelContainerStatsRecord | null;
  error?: string;
}

async function fetchContainerStats(
  token: string,
  system: BeszelSystemRecord,
): Promise<ContainerStatsResult> {
  const fields = { target: safeTarget(BESZEL_URL), machine: system.name, systemId: system.id };
  const resource = `beszel:container_stats:${system.id}`;
  try {
    const params = new URLSearchParams({
      filter: `system='${system.id}'`,
      sort: "-created",
      perPage: "1",
      fields: "id,system,created,stats",
    });
    const res = await beszelFetch(
      `/api/collections/container_stats/records?${params.toString()}`,
      "container_stats",
      { headers: { authorization: token } },
    );
    if (!res.ok) {
      // Older hubs may not have this collection; treat a missing collection as empty data.
      reportHealth(resource, false, "beszel.container_stats", {
        ...fields,
        httpStatus: res.status,
      });
      return {
        record: null,
        ...(res.status === 404 ? {} : { error: "container stats unavailable" }),
      };
    }
    const data = (await res.json()) as { items: BeszelContainerStatsRecord[] };
    reportHealth(resource, true, "beszel.container_stats", fields);
    return { record: data.items[0] ?? null };
  } catch (error) {
    reportHealth(resource, false, "beszel.container_stats", { ...fields, ...errorDetails(error) });
    return { record: null, error: "container stats unavailable" };
  }
}

function normalizeRemoteContainer(stat: BeszelCompactContainerStat): RemoteContainer {
  const cpuPct = finiteNonNegative(stat.c);
  const memBytes = mebibytesToBytes(stat.m);
  return {
    name: stat.n,
    ...(cpuPct !== undefined ? { cpuPct } : {}),
    ...(memBytes !== undefined ? { memBytes } : {}),
    ...networkRates(stat.b),
  };
}

async function fetchRemoteContainers(): Promise<RemoteContainersResponse> {
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

  // A failed request only marks that machine; healthy machines still report their containers.
  const bySystem = await Promise.all(
    records.map(async (record): Promise<RemoteSystemContainers> => {
      const { record: statsRecord, error } = await fetchContainerStats(token, record);
      const stats = Array.isArray(statsRecord?.stats) ? statsRecord.stats : [];
      const containers = stats
        .filter((stat): stat is BeszelCompactContainerStat => isCompactStat(stat))
        .map(normalizeRemoteContainer)
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        systemId: record.id,
        systemName: record.name,
        systemHost: record.host,
        systemStatus: record.status,
        containers,
        ...(error ? { error } : {}),
      };
    }),
  );

  return { configured: true, bySystem };
}

export function getRemoteContainers() {
  return monitor(
    "beszel:containers",
    "beszel.containers",
    {
      target: safeTarget(BESZEL_URL),
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
    fetchRemoteContainers,
  );
}
