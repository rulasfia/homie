import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { bookmarkUrls, loadConfig } from "./config.ts";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const mockedReadFile = vi.mocked(readFile);

const defaults = {
  title: "homie",
  openInNewTab: true,
  pingTimeoutMs: 5000,
  cacheTtlMs: 5000,
  machines: [],
  groups: [],
};

/** Loads one mocked config file and returns the parsed result. */
async function load(yaml: string) {
  mockedReadFile.mockResolvedValueOnce(yaml);
  return loadConfig();
}

/** Loads a config expected to fail and returns its error. */
async function loadError(yaml: string): Promise<Error> {
  try {
    await load(yaml);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected loadConfig to reject");
}

/** Minimal bookmark config around a URL under test. */
function bookmarkConfig(url: string): string {
  return `groups:
  - name: Links
    bookmarks:
      - name: Example
        url: ${JSON.stringify(url)}
`;
}

beforeEach(() => {
  mockedReadFile.mockReset();
});

describe("defaults and valid configs", () => {
  it.each(["", " \n", "# comment only\n", "---\n"])(
    "uses defaults for empty YAML input %s",
    async (yaml) => {
      await expect(load(yaml)).resolves.toEqual(defaults);
    },
  );

  it("keeps an explicit openInNewTab false", async () => {
    const config = await load("openInNewTab: false\n");
    expect(config.openInNewTab).toBe(false);
  });

  it("parses groups, bookmarks, machines, and optional fields", async () => {
    const config = await load(`
title: Lab
openInNewTab: false
pingTimeoutMs: 1500
cacheTtlMs: 0
machines:
  - name: homeserver
    address: root@192.168.1.10
  - name: nas
groups:
  - name: Monitoring
    bookmarks:
      - name: Beszel
        url: https://beszel.example.com
        description: Metrics
        icon: 🛰️
        ping: true
        insecure: true
      - name: Router
        url: http://192.168.1.1
`);

    expect(config).toEqual({
      title: "Lab",
      openInNewTab: false,
      pingTimeoutMs: 1500,
      cacheTtlMs: 0,
      machines: [{ name: "homeserver", address: "root@192.168.1.10" }, { name: "nas" }],
      groups: [
        {
          name: "Monitoring",
          bookmarks: [
            {
              name: "Beszel",
              url: "https://beszel.example.com",
              description: "Metrics",
              icon: "🛰️",
              ping: true,
              insecure: true,
            },
            { name: "Router", url: "http://192.168.1.1" },
          ],
        },
      ],
    });
  });

  it("treats null optional values like omitted values", async () => {
    const config = await load(`
title:
openInNewTab:
pingTimeoutMs:
cacheTtlMs:
machines:
groups:
`);
    expect(config).toEqual(defaults);
  });

  it("treats null nested optional values like omitted values", async () => {
    const config = await load(`
groups:
  - name: Links
    bookmarks:
      - name: Example
        url: https://example.com
        description:
        icon:
        ping:
        insecure:
machines:
  - name: host
    address:
`);

    expect(config.groups).toEqual([
      { name: "Links", bookmarks: [{ name: "Example", url: "https://example.com" }] },
    ]);
    expect(config.machines).toEqual([{ name: "host" }]);
  });

  it("ignores unknown keys for forward compatibility", async () => {
    const config = await load(`
title: Lab
futureOption: true
groups:
  - name: Links
    color: blue
    bookmarks:
      - name: Example
        url: https://example.com
        badge: new
machines:
  - name: host
    note: rack 1
`);

    expect(config.title).toBe("Lab");
    expect(config).not.toHaveProperty("futureOption");
    expect(config.groups[0]).not.toHaveProperty("color");
    expect(config.groups[0].bookmarks[0]).not.toHaveProperty("badge");
    expect(config.machines?.[0]).not.toHaveProperty("note");
  });

  it("accepts timer boundary values", async () => {
    const config = await load("pingTimeoutMs: 2147483647\ncacheTtlMs: 0\n");
    expect(config.pingTimeoutMs).toBe(2147483647);
    expect(config.cacheTtlMs).toBe(0);
  });
});

describe("shape and primitive validation", () => {
  it.each([
    ["- one\n", "top-level config must be a mapping"],
    ["hello\n", "top-level config must be a mapping"],
    ["groups: nope\n", "groups must be an array"],
    ["groups:\n  - nope\n", "groups[0] must be a mapping"],
    ["groups:\n  - name: Links\n", "groups[0].bookmarks must be an array"],
    ["groups:\n  - name: Links\n    bookmarks: nope\n", "groups[0].bookmarks must be an array"],
    [
      "groups:\n  - name: Links\n    bookmarks:\n      - nope\n",
      "groups[0].bookmarks[0] must be a mapping",
    ],
    [
      "groups:\n  - name: Links\n    bookmarks:\n      - name: Example\n",
      "groups[0].bookmarks[0].url must be a string",
    ],
    [
      "groups:\n  - name: Links\n    bookmarks:\n      - url: https://example.com\n",
      "groups[0].bookmarks[0].name must be a string",
    ],
    ["machines: nope\n", "machines must be an array"],
    ["machines:\n  - nope\n", "machines[0] must be a mapping"],
    ["machines:\n  - address: host\n", "machines[0].name must be a string"],
  ])("rejects malformed shape %#", async (yaml, message) => {
    await expect(load(yaml)).rejects.toThrow(message);
  });

  it.each([
    ["groups:\n  - name: '  '\n    bookmarks: []\n", "groups[0].name must not be empty"],
    [
      "groups:\n  - name: Links\n    bookmarks:\n      - name: ''\n        url: https://example.com\n",
      "groups[0].bookmarks[0].name must not be empty",
    ],
    ["machines:\n  - name: ''\n", "machines[0].name must not be empty"],
  ])("rejects empty required names %#", async (yaml, message) => {
    await expect(load(yaml)).rejects.toThrow(message);
  });

  it.each([
    ["title: 42\n", "title must be a string"],
    ["openInNewTab: yes\n", "openInNewTab must be a boolean"],
    ["pingTimeoutMs: '5000'\n", "pingTimeoutMs must be a finite integer"],
    ["cacheTtlMs: true\n", "cacheTtlMs must be a finite integer"],
    ["groups:\n  - name: 12\n    bookmarks: []\n", "groups[0].name must be a string"],
    [
      "groups:\n  - name: Links\n    bookmarks:\n      - name: Example\n        url: https://example.com\n        description: 42\n",
      "groups[0].bookmarks[0].description must be a string",
    ],
    [
      "groups:\n  - name: Links\n    bookmarks:\n      - name: Example\n        url: https://example.com\n        icon: 42\n",
      "groups[0].bookmarks[0].icon must be a string",
    ],
    [
      "groups:\n  - name: Links\n    bookmarks:\n      - name: Example\n        url: https://example.com\n        ping: 'true'\n",
      "groups[0].bookmarks[0].ping must be a boolean",
    ],
    [
      "groups:\n  - name: Links\n    bookmarks:\n      - name: Example\n        url: https://example.com\n        insecure: 'true'\n",
      "groups[0].bookmarks[0].insecure must be a boolean",
    ],
    ["machines:\n  - name: host\n    address: 42\n", "machines[0].address must be a string"],
  ])("rejects wrong primitive type %#", async (yaml, message) => {
    await expect(load(yaml)).rejects.toThrow(message);
  });

  it.each([
    "pingTimeoutMs: 0",
    "pingTimeoutMs: -1",
    "pingTimeoutMs: 1.5",
    "pingTimeoutMs: .inf",
    "pingTimeoutMs: .nan",
    "pingTimeoutMs: 2147483648",
    "cacheTtlMs: -1",
    "cacheTtlMs: 1.5",
    "cacheTtlMs: .inf",
    "cacheTtlMs: .nan",
    "cacheTtlMs: 2147483648",
  ])("rejects out-of-range timer setting %s", async (yaml) => {
    await expect(load(`${yaml}\n`)).rejects.toThrow(
      /^(invalid homie config: (pingTimeoutMs|cacheTtlMs) )/,
    );
  });
});

describe("bookmark URL policy", () => {
  it("does not normalize bookmark URLs used by the ping allowlist", async () => {
    const url = "https://Example.com:8443/path?token=abc#status";
    const config = await load(bookmarkConfig(url));

    expect(config.groups[0].bookmarks[0].url).toBe(url);
    expect(bookmarkUrls(config)).toEqual(new Set([url]));
  });

  it.each([
    "example.com",
    "/admin",
    "ftp://example.com",
    "mailto:user@example.com",
    "javascript:alert(1)",
    "https://",
    "http://[invalid",
  ])("rejects non-http(s) bookmark URL %s", async (url) => {
    await expect(load(bookmarkConfig(url))).rejects.toThrow(
      /groups\[0\]\.bookmarks\[0\]\.url must be an absolute http\(s\) URL/,
    );
  });
});

describe("runtime behavior", () => {
  it("re-reads the config on every call", async () => {
    mockedReadFile
      .mockResolvedValueOnce("title: First\ngroups: []\n")
      .mockResolvedValueOnce("title: Second\ngroups: []\n");

    await expect(loadConfig()).resolves.toMatchObject({ title: "First" });
    await expect(loadConfig()).resolves.toMatchObject({ title: "Second" });
    expect(mockedReadFile).toHaveBeenCalledTimes(2);
  });

  it("reports YAML syntax errors without echoing config contents", async () => {
    const secret = "swordfish-secret";
    const error = await loadError(`title: *${secret}\n`);

    expect(error.message).toBe("invalid homie config: YAML syntax error");
    expect(error.message).not.toContain(secret);
  });

  it("includes the location of YAML syntax errors", async () => {
    const error = await loadError("title: [\n");

    expect(error.message).toMatch(/YAML syntax error at line 2, column 1/);
  });
});
