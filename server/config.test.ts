import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vite-plus/test";
import { loadConfig } from "./config.ts";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

it.each([
  ["title: Homie", true],
  ["openInNewTab: true", true],
  ["openInNewTab: false", false],
])("loads bookmark tab preference from %s", async (yaml, expected) => {
  vi.mocked(readFile).mockResolvedValue(yaml);
  expect((await loadConfig()).openInNewTab).toBe(expected);
});
