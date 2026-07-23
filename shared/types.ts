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
