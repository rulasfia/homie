/** Shared types between the server and the frontend. */

export interface Bookmark {
  name: string;
  url: string;
  description?: string;
  /** Emoji, single letter, or image URL. Falls back to first letter of name. */
  icon?: string;
  /** If true, the backend periodically checks reachability of `url`. */
  ping?: boolean;
}

export interface BookmarkGroup {
  name: string;
  bookmarks: Bookmark[];
}

export interface HomieConfig {
  title: string;
  /** Timeout for ping checks, in milliseconds. Default 5000. */
  pingTimeoutMs?: number;
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
  /** Memory usage percent (0-100). */
  memPct?: number;
  /** Network I/O bytes since the container started (or per interval, Beszel-specific). */
  netBytes?: number;
}

export interface RemoteSystemContainers {
  systemId: string;
  systemName: string;
  systemHost: string;
  systemStatus: string;
  containers: RemoteContainer[];
}

export interface RemoteContainersResponse {
  /** False when Beszel env vars are not set — frontend hides the section. */
  configured: boolean;
  /** Empty when Beszel is configured but returned no container data. */
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
  /** Only present for remote containers from Beszel. */
  memPct?: number;
  /** Only present for remote containers from Beszel. */
  netBytes?: number;
}

export interface ContainersAllResponse {
  /** False when neither Docker nor Beszel is configured. */
  configured: boolean;
  /** Sources available in the response (e.g. "local" + each remote system). */
  sources: Array<{ id: string; name: string }>;
  containers: UnifiedContainer[];
}
