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
  return data.token;
}

// PocketBase user tokens are long-lived. The login promise is shared, so callers that
// need a token while a login is in flight await the same one; it is dropped on failure
// or after a 401, so the next call logs in again.
let tokenPromise: Promise<string> | null = null;

function getToken(): Promise<string> {
  if (!tokenPromise) {
    const login = authenticate().catch((err) => {
      if (tokenPromise === login) tokenPromise = null;
      throw err;
    });
    tokenPromise = login;
  }
  return tokenPromise;
}

/**
 * Runs `request` with the shared token. On a 401 the token is invalidated (unless a
 * newer login already replaced it, so concurrent 401s share one re-login) and the
 * request is retried once with a fresh token.
 */
async function withToken<T>(request: (token: string) => Promise<T>): Promise<T> {
  const used = getToken();
  const token = await used;
  try {
    return await request(token);
  } catch (err) {
    if ((err as { httpStatus?: number }).httpStatus !== 401) throw err;
    if (tokenPromise === used) tokenPromise = null;
    return request(await getToken());
  }
}

interface BeszelSystemRecord {
  id: string;
  name: string;
  host: string;
  status: string;
  info: Record<string, unknown>;
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

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
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
function normalize(record: BeszelSystemRecord): SystemStatus {
  const info = record.info ?? {};
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
  };
}

async function fetchSystems(): Promise<SystemStatus[]> {
  const records = await withToken(fetchSystemRecords);
  return records.map(normalize);
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

function fetchRemoteContainers(): Promise<RemoteContainersResponse> {
  return withToken(async (token) => {
    const records = await fetchSystemRecords(token);

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
  });
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
