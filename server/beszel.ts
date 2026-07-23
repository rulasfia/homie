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

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
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

export async function getSystems(): Promise<SystemStatus[]> {
  let token = cachedToken ?? (await authenticate());
  try {
    return (await fetchSystemRecords(token)).map(normalize);
  } catch (err) {
    if ((err as { httpStatus?: number }).httpStatus !== 401) throw err;
    cachedToken = null;
    token = await authenticate();
    return (await fetchSystemRecords(token)).map(normalize);
  }
}
