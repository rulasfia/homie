import { afterEach, expect, it, vi } from "vite-plus/test";
import { fetchConfig } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

it("preserves safe field-level config errors from the server", async () => {
  const error = "invalid homie config: groups[0].bookmarks must be an array";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error }, { status: 500 })),
  );
  await expect(fetchConfig()).rejects.toThrow(error);
});

it.each(["not json", '{"error":42}'])(
  "handles an unexpected config error body %s",
  async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 500 })),
    );
    await expect(fetchConfig()).rejects.toThrow("failed to load config: 500");
  },
);
