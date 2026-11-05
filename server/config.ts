import { readFile, stat } from "node:fs/promises";
import YAML, { YAMLError } from "yaml";
import { DEFAULT_THEME, isTheme, THEMES, type Theme } from "../shared/themes.ts";
import type { Bookmark, BookmarkGroup, HomieConfig, MachineConfig } from "../shared/types.ts";

const CONFIG_PATH = process.env.HOMIE_CONFIG ?? "homie.config.yaml";

const DEFAULT_PING_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 5000;
/** Largest delay Node timers accept; larger values overflow and fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;

type ConfigObject = Record<string, unknown>;

/** Contains only safe field paths and constraints, never configuration values. */
export class ConfigValidationError extends Error {}

function invalidConfig(message: string): never {
  throw new ConfigValidationError(`invalid homie config: ${message}`);
}

function isObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalidConfig(`${path} must be a string`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string") invalidConfig(`${path} must be a string`);
  if (value.trim() === "") invalidConfig(`${path} must not be empty`);
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalidConfig(`${path} must be a boolean`);
  return value;
}

function optionalTheme(value: unknown, path: string): Theme | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isTheme(value)) invalidConfig(`${path} must be one of: ${THEMES.join(", ")}`);
  return value;
}

function optionalArray(value: unknown, path: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalidConfig(`${path} must be an array`);
  return value;
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalidConfig(`${path} must be an array`);
  return value;
}

function optionalInteger(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    invalidConfig(`${path} must be a finite integer between ${min} and ${max}`);
  }
  if (value < min || value > max) {
    invalidConfig(`${path} must be between ${min} and ${max}`);
  }
  return value;
}

/** A non-empty list of HTTP status codes; an empty list would mark the service always down. */
function optionalStatusList(value: unknown, path: string): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  const items = requiredArray(value, path);
  if (items.length === 0) invalidConfig(`${path} must not be empty`);
  return items.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (item === undefined || item === null) {
      invalidConfig(`${itemPath} must be a finite integer between 100 and 599`);
    }
    return optionalInteger(item, itemPath, 100, 599) as number;
  });
}

/** Absolute http(s) URLs match the navigation policy in src/safety.ts. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseBookmark(value: unknown, path: string): Bookmark {
  if (!isObject(value)) invalidConfig(`${path} must be a mapping`);

  const name = requiredString(value.name, `${path}.name`);
  const url = requiredString(value.url, `${path}.url`);
  // Validate without normalizing: the exact string is the ping allowlist identity.
  if (!isHttpUrl(url)) invalidConfig(`${path}.url must be an absolute http(s) URL`);

  const bookmark: Bookmark = { name, url };
  const description = optionalString(value.description, `${path}.description`);
  if (description !== undefined) bookmark.description = description;
  const icon = optionalString(value.icon, `${path}.icon`);
  if (icon !== undefined) bookmark.icon = icon;
  const ping = optionalBoolean(value.ping, `${path}.ping`);
  if (ping !== undefined) bookmark.ping = ping;
  const expectStatus = optionalStatusList(value.expectStatus, `${path}.expectStatus`);
  if (expectStatus !== undefined) bookmark.expectStatus = expectStatus;
  const insecure = optionalBoolean(value.insecure, `${path}.insecure`);
  if (insecure !== undefined) bookmark.insecure = insecure;
  return bookmark;
}

function parseGroup(value: unknown, path: string): BookmarkGroup {
  if (!isObject(value)) invalidConfig(`${path} must be a mapping`);

  const name = requiredString(value.name, `${path}.name`);
  const bookmarks = requiredArray(value.bookmarks, `${path}.bookmarks`).map((bookmark, index) =>
    parseBookmark(bookmark, `${path}.bookmarks[${index}]`),
  );
  return { name, bookmarks };
}

function parseMachine(value: unknown, path: string): MachineConfig {
  if (!isObject(value)) invalidConfig(`${path} must be a mapping`);

  const name = requiredString(value.name, `${path}.name`);
  const address = optionalString(value.address, `${path}.address`);
  return address === undefined ? { name } : { name, address };
}

function parseYaml(raw: string): unknown {
  try {
    return YAML.parse(raw, { logLevel: "error" });
  } catch (error) {
    // Parse errors can include offending source text; report only the location.
    const position = error instanceof YAMLError ? error.linePos?.[0] : undefined;
    const location = position ? ` at line ${position.line}, column ${position.col}` : "";
    invalidConfig(`YAML syntax error${location}`);
  }
}

/** Freezes the parsed config so a caller cannot change the shared cached copy. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Reads, parses, and validates the YAML config. Unknown keys are ignored to keep configs forward-compatible. */
async function readConfig(): Promise<HomieConfig> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = parseYaml(raw);
  const document = parsed === null || parsed === undefined ? {} : parsed;
  if (!isObject(document)) invalidConfig("top-level config must be a mapping");

  return deepFreeze({
    title: optionalString(document.title, "title") ?? "homie",
    theme: optionalTheme(document.theme, "theme") ?? DEFAULT_THEME,
    openInNewTab: optionalBoolean(document.openInNewTab, "openInNewTab") ?? true,
    pingTimeoutMs:
      optionalInteger(document.pingTimeoutMs, "pingTimeoutMs", 1, MAX_TIMER_MS) ??
      DEFAULT_PING_TIMEOUT_MS,
    cacheTtlMs:
      optionalInteger(document.cacheTtlMs, "cacheTtlMs", 0, MAX_TIMER_MS) ?? DEFAULT_CACHE_TTL_MS,
    machines: optionalArray(document.machines, "machines").map((machine, index) =>
      parseMachine(machine, `machines[${index}]`),
    ),
    groups: optionalArray(document.groups, "groups").map((group, index) =>
      parseGroup(group, `groups[${index}]`),
    ),
  });
}

let cachedConfig: { version: string; config: Promise<HomieConfig> } | undefined;

/**
 * Returns the current config, deep-frozen. Called per request so config edits
 * take effect without restarting the server; a `stat` per call keeps that cheap
 * by reusing the last parse while mtime, size and inode are unchanged (the inode
 * catches editors and bind mounts that replace the file). Concurrent callers
 * share one read+parse, and a failed read or validation is not cached.
 */
export async function loadConfig(): Promise<HomieConfig> {
  const { mtimeMs, size, ino } = await stat(CONFIG_PATH);
  const version = `${mtimeMs}:${size}:${ino}`;
  if (cachedConfig?.version === version) return cachedConfig.config;

  const entry = { version, config: readConfig() };
  cachedConfig = entry;
  entry.config.catch(() => {
    if (cachedConfig === entry) cachedConfig = undefined;
  });
  return entry.config;
}
