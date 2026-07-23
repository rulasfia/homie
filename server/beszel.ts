import type { SystemStatus } from "../shared/types.ts";

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
