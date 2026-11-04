/** Shared types between the server and the frontend. */

export interface Bookmark {
  name: string;
  url: string;
  description?: string;
  /** Emoji, single letter, or image URL. Falls back to first letter of name. */
  icon?: string;
  /** If true, the backend periodically checks reachability of `url`. */
  ping?: boolean;
  /**
   * HTTP status codes (100-599) that count as "up" for the ping check. When
   * set, only these statuses are up. Default: anything below 400, plus 401
   * and 403. Must not be empty. Redirects are followed, so 3xx codes never match.
   */
  expectStatus?: number[];
  /**
   * If true, the ping skips TLS certificate verification for this bookmark only
   * (for self-signed certificates). Default false. Risk: the check cannot tell
   * the real service from an impostor, so only enable it for hosts on a network
   * you trust. Beszel and all other requests stay verified.
   */
  insecure?: boolean;
}

export interface BookmarkGroup {
  name: string;
  bookmarks: Bookmark[];
}

export interface MachineConfig {
  /** Must exactly match the machine name reported by Beszel. */
  name: string;
  /** Address copied from the machine card, e.g. an IP address or SSH target. */
  address?: string;
}

export interface HomieConfig {
  title: string;
  /** Open bookmarks in a new tab. Default true. */
  openInNewTab?: boolean;
  /** Timeout for ping checks, in milliseconds. Default 5000. */
  pingTimeoutMs?: number;
  /** Server-side cache TTL for ping, systems, and containers APIs, in milliseconds. Default 5000. Set to 0 to disable. */
  cacheTtlMs?: number;
  machines?: MachineConfig[];
  groups: BookmarkGroup[];
}

export interface PingResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error?: string;
}

/** Normalized view of one machine monitored by Beszel. */
export interface SystemStatus {
  id: string;
  name: string;
  host: string;
  /** User-configured address to copy from the machine card. */
  address?: string;
  /** "up" | "down" | "paused" | "pending" */
  status: string;
  /** Uptime in seconds. */
  uptime: number;
  /** CPU usage percent (0-100). */
  cpu: number;
  /** Memory usage percent (0-100). */
  memPct: number;
  /** Disk usage percent (0-100). */
  diskPct: number;
  loadAvg?: [number, number, number];
  /** Dashboard temperature in °C. */
  temp?: number;
  agentVersion: string;
  /** Static hardware / OS specs (optional because some agents may omit them). */
  specs?: {
    cpuModel?: string;
    cores?: number;
    threads?: number;
    /** Total memory in bytes. */
    memoryTotalBytes?: number;
    osName?: string;
    arch?: string;
  };
}

export interface SystemsResponse {
  /** False when Beszel env vars are not set — frontend hides the section. */
  configured: boolean;
  systems: SystemStatus[];
}

/** One Docker container on the machine running homie. */
export interface ContainerInfo {
  /** Short (12-char) container id. */
  id: string;
  name: string;
  image: string;
  /** "running" | "exited" | "paused" | "created" | ... */
  state: string;
  /** Human-readable status from Docker, e.g. "Up 3 days". */
  status: string;
  /** Published port mappings, e.g. ["8080:80"]. */
  ports: string[];
}

export interface ContainersResponse {
  /** False when no Docker socket is available — frontend hides the section. */
  configured: boolean;
  containers: ContainerInfo[];
}

/** One Docker container from a remote machine monitored by Beszel. */
export interface RemoteContainer {
  name: string;
  /** CPU usage percent (0-100). */
  cpuPct?: number;
  /** Memory used in bytes (Beszel reports mebibytes, normalized by the server). */
  memBytes?: number;
  /** Outbound network throughput in bytes per second. */
  netSentBps?: number;
  /** Inbound network throughput in bytes per second. */
  netRecvBps?: number;
}

export interface RemoteSystemContainers {
  systemId: string;
  systemName: string;
  systemHost: string;
  systemStatus: string;
  containers: RemoteContainer[];
  /** Safe reason when this machine's container stats could not be fetched. */
  error?: string;
}

export interface RemoteContainersResponse {
  /** False when Beszel env vars are not set — frontend hides the section. */
  configured: boolean;
  /** One entry per monitored system, including machines that reported no containers. */
  bySystem: RemoteSystemContainers[];
}

/** A container shown in the unified container table, either local or remote. */
export interface UnifiedContainer {
  /** Short (12-char) container id. Only present for local Docker containers. */
  id?: string;
  name: string;
  /** Only present for local Docker containers. */
  image?: string;
  /** "running" | "exited" | "paused" | "created" | "unknown" | ... */
  state: string;
  /** Human-readable status from Docker. Only present for local containers. */
  status?: string;
  /** Published port mappings. Only present for local containers. */
  ports?: string[];
  /** "local" for the Docker socket attached to homie, "remote" for Beszel agents. */
  source: "local" | "remote";
  /** Machine name the container belongs to. "local" for the Docker host. */
  systemName: string;
  /** System id for remote machines; undefined for local. */
  systemId?: string;
  /** Only present for remote containers from Beszel. */
  cpuPct?: number;
  /** Memory used in bytes. Only present for remote containers from Beszel. */
  memBytes?: number;
  /** Outbound network throughput in bytes per second. Only present for remote containers from Beszel. */
  netSentBps?: number;
  /** Inbound network throughput in bytes per second. Only present for remote containers from Beszel. */
  netRecvBps?: number;
}

/** A configured container source, including its failure state when applicable. */
export interface ContainerSource {
  /** "local", a Beszel system id, or "beszel" when the whole integration failed. */
  id: string;
  /** Hostname for local Docker, the Beszel system name, or "Beszel". */
  name: string;
  /** Safe reason when this source failed; omitted when it responded. */
  error?: string;
}

export interface ContainersAllResponse {
  /** False when neither Docker nor Beszel is configured. */
  configured: boolean;
  /** Configured sources; `error` distinguishes failed sources from empty ones. */
  sources: ContainerSource[];
  containers: UnifiedContainer[];
  /** True when some sources failed while others still returned data. */
  partial?: boolean;
  /** Present when every configured source failed (HTTP 502). */
  error?: string;
}
