import { mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

let dir: string;
let path: string;

// A fresh module per test so the config cache and HOMIE_CONFIG path start clean.
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homie-config-"));
  path = join(dir, "homie.config.yaml");
  vi.stubEnv("HOMIE_CONFIG", path);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function loadConfig() {
  const config = await import("./config.ts");
  return config.loadConfig();
}

// Whole seconds, so the timestamp round-trips exactly through utimes.
const FIXED_TIME = new Date("2026-01-01T00:00:00Z");

/** Writes the file with a fixed mtime, so only size or inode can reveal an edit. */
async function writeFixedMtime(target: string, yaml: string) {
  await writeFile(target, yaml);
  await utimes(target, FIXED_TIME, FIXED_TIME);
}

it.each([
  ["title: Homie", true],
  ["openInNewTab: true", true],
  ["openInNewTab: false", false],
])("loads bookmark tab preference from %s", async (yaml, expected) => {
  await writeFile(path, yaml);
  expect((await loadConfig()).openInNewTab).toBe(expected);
});

it("reuses the frozen parse while the file is unchanged and re-reads after it changes", async () => {
  await writeFixedMtime(path, "title: AAAA\ngroups: [{ name: Links, bookmarks: [] }]\n");
  const [first, concurrent] = await Promise.all([loadConfig(), loadConfig()]);
  expect(concurrent).toBe(first);
  expect(await loadConfig()).toBe(first);
  expect(Object.isFrozen(first.groups[0].bookmarks)).toBe(true);

  // Same size and inode: only the bumped mtime shows the edit.
  await writeFixedMtime(path, "title: BBBB\ngroups: [{ name: Links, bookmarks: [] }]\n");
  expect((await loadConfig()).title).toBe("AAAA");
  const later = new Date(FIXED_TIME.getTime() + 60_000);
  await utimes(path, later, later);
  expect((await loadConfig()).title).toBe("BBBB");

  // Same size and mtime, but the file was replaced: only the inode changed.
  const replacement = join(dir, "replacement.yaml");
  await writeFile(replacement, "title: CCCC\ngroups: [{ name: Links, bookmarks: [] }]\n");
  await utimes(replacement, later, later);
  await rename(replacement, path);
  expect((await loadConfig()).title).toBe("CCCC");
});

it("does not cache a failed parse", async () => {
  await writeFixedMtime(path, "title: [");
  await expect(loadConfig()).rejects.toThrow("YAML syntax error");

  // Same size, mtime and inode as the broken file, so only a retry can see the fix.
  await writeFixedMtime(path, "title: x");
  expect((await loadConfig()).title).toBe("x");
});
