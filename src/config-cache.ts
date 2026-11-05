import { isTheme } from "../shared/themes.ts";
import type { HomieConfig } from "../shared/types.ts";

const CONFIG_KEY = "homie:config";
// Bump when RenderedConfig changes shape so older saved data is ignored.
const CONFIG_VERSION = 2;

/** The part of the config the page renders from. Machines and ping/cache tuning are not stored. */
export type RenderedConfig = Pick<HomieConfig, "title" | "theme" | "openInNewTab" | "groups">;

export function renderedConfig({
  title,
  theme,
  openInNewTab,
  groups,
}: HomieConfig): RenderedConfig {
  return { title, theme, openInNewTab, groups };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOptional = (value: unknown, type: "string" | "boolean") =>
  value === undefined || typeof value === type;

function isBookmark(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.url === "string" &&
    isOptional(value.description, "string") &&
    isOptional(value.icon, "string") &&
    isOptional(value.ping, "boolean")
  );
}

function isRenderedConfig(value: unknown): value is RenderedConfig {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    (value.theme === undefined || isTheme(value.theme)) &&
    isOptional(value.openInNewTab, "boolean") &&
    Array.isArray(value.groups) &&
    value.groups.every(
      (group) =>
        isRecord(group) &&
        typeof group.name === "string" &&
        Array.isArray(group.bookmarks) &&
        group.bookmarks.every(isBookmark),
    )
  );
}

/**
 * The config saved by the last visit, or undefined when there is none, it is
 * unparsable, has the wrong version or shape, or storage is blocked. Bad data
 * is removed. Saved data is as untrusted as server data: render it escaped.
 */
export function loadCachedConfig(): RenderedConfig | undefined {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw === null) return undefined;
    try {
      const saved: unknown = JSON.parse(raw);
      if (isRecord(saved) && saved.version === CONFIG_VERSION && isRenderedConfig(saved.config)) {
        return saved.config;
      }
    } catch {
      // Unparsable: dropped below.
    }
    localStorage.removeItem(CONFIG_KEY);
  } catch {
    // Storage is blocked: no fast path, the page loads from the network as usual.
  }
  return undefined;
}

/** Saves what the page renders from for the next visit's first paint. */
export function saveCachedConfig(config: RenderedConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ version: CONFIG_VERSION, config }));
  } catch {
    // Without storage the next visit just waits for the network.
  }
}
