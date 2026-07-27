import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { HomieConfig } from "../shared/types.ts";

const CONFIG_PATH = process.env.HOMIE_CONFIG ?? "homie.config.yaml";

/**
 * Reads and parses the YAML config. Called per request so config edits
 * take effect without restarting the server.
 */
export async function loadConfig(): Promise<HomieConfig> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const config = YAML.parse(raw) as HomieConfig;
  config.title ??= "homie";
  config.pingTimeoutMs ??= 5000;
  config.cacheTtlMs ??= 5000;
  config.machines ??= [];
  config.groups ??= [];
  return config;
}

/** All bookmark URLs — used as an allowlist for the ping endpoint. */
export function bookmarkUrls(config: HomieConfig): Set<string> {
  return new Set(config.groups.flatMap((g) => g.bookmarks.map((b) => b.url)));
}
