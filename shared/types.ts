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
}

export interface SystemsResponse {
  /** False when Beszel env vars are not set — frontend hides the section. */
  configured: boolean;
  systems: SystemStatus[];
}
