import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { loadConfig } from "./config.ts";

// A new inode per stat makes every load a cache miss, so each test parses its own YAML.
vi.mock("node:fs/promises", () => {
  let ino = 0;
  return { readFile: vi.fn(), stat: vi.fn(async () => ({ mtimeMs: 0, size: 0, ino: ++ino })) };
});

const mockedReadFile = vi.mocked(readFile);

const defaults = {
  title: "homie",
  theme: "aqua",
  openInNewTab: true,
  pingTimeoutMs: 5000,
  cacheTtlMs: 5000,
  machines: [],
  feeds: [],
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
theme: metal
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
      theme: "metal",
      openInNewTab: false,
      pingTimeoutMs: 1500,
      cacheTtlMs: 0,
      machines: [{ name: "homeserver", address: "root@192.168.1.10" }, { name: "nas" }],
      feeds: [],
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
theme:
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
  it("does not normalize bookmark URLs used as ping targets", async () => {
    const url = "https://Example.com:8443/path?token=abc#status";
    const config = await load(bookmarkConfig(url));

    expect(config.groups[0].bookmarks[0].url).toBe(url);
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

describe("feeds", () => {
  it.each(["", "feeds: []\n", "feeds: null\n"])(
    "keeps feeds disabled for existing configs with %j",
    async (option) => {
      const config = await load(option + bookmarkConfig("https://service.test"));
      expect(config.feeds).toEqual([]);
      expect(config.groups).toEqual([
        { name: "Links", bookmarks: [{ name: "Example", url: "https://service.test" }] },
      ]);
    },
  );

  it("normalizes identities and freezes feed configuration", async () => {
    const config = await load('feeds: [{ name: Blog, url: "https://BLOG.test:443/feed#top" }]');
    expect(config.feeds).toEqual([{ name: "Blog", url: "https://blog.test/feed" }]);
    expect(Object.isFrozen(config.feeds)).toBe(true);
    expect(Object.isFrozen(config.feeds?.[0])).toBe(true);
  });

  it.each([
    ["nope", "feeds must be an array"],
    ["[nope]", "feeds[0] must be a mapping"],
    ['[{ name: "", url: "https://blog.test" }]', "feeds[0].name must not be empty"],
    ['[{ name: Blog, url: "/feed" }]', "feeds[0].url must be an absolute http(s) URL"],
    [
      '[{ name: Blog, url: "ftp://blog.test/feed" }]',
      "feeds[0].url must be an absolute http(s) URL",
    ],
    ['[{ name: Blog, url: "https://user:secret@blog.test/feed" }]', "without credentials"],
    [
      '[{ name: Blog, url: "https://blog.test" }, { name: Again, url: "https://BLOG.test:443/#a" }]',
      "feeds[1].url must be unique",
    ],
  ])("rejects invalid feeds %# without disclosing values", async (yaml, message) => {
    const error = await loadError(`feeds: ${yaml}`);
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("secret");
  });

  it("accepts private-network feeds and limits the number of feeds", async () => {
    expect(
      (await load('feeds: [{ name: Local, url: "http://192.168.1.2/feed" }]')).feeds,
    ).toHaveLength(1);
    const feeds = Array.from({ length: 33 }, (_, index) => ({
      name: "Blog",
      url: `https://blog.test/${index}`,
    }));
    await expect(load(`feeds: ${JSON.stringify(feeds)}`)).rejects.toThrow("at most 32");
    expect((await load(`feeds: ${JSON.stringify(feeds.slice(0, 32))}`)).feeds).toHaveLength(32);
  });
});

describe("bookmark expectStatus", () => {
  const withExpect = (value: string) =>
    `groups:\n  - name: Links\n    bookmarks:\n      - name: Example\n        url: https://example.com\n        expectStatus: ${value}\n`;

  it("accepts a list of status codes and defaults to unset", async () => {
    const config = await load(withExpect("[200, 404, 599, 100]"));
    expect(config.groups[0].bookmarks[0].expectStatus).toEqual([200, 404, 599, 100]);
    const plain = await load(bookmarkConfig("https://example.com"));
    expect(plain.groups[0].bookmarks[0]).not.toHaveProperty("expectStatus");
  });

  it.each([
    ["200", "must be an array"],
    ["'200'", "must be an array"],
    ["[200, '404']", "expectStatus[1] must be a finite integer between 100 and 599"],
    ["[200, null]", "expectStatus[1] must be a finite integer between 100 and 599"],
    ["[200.5]", "expectStatus[0] must be a finite integer between 100 and 599"],
    ["[99]", "expectStatus[0] must be between 100 and 599"],
    ["[600]", "expectStatus[0] must be between 100 and 599"],
    ["[]", "expectStatus must not be empty"],
  ])("rejects expectStatus %s", async (value, message) => {
    const error = await loadError(withExpect(value));
    expect(error.message).toContain(`groups[0].bookmarks[0].expectStatus`);
    expect(error.message).toContain(message);
  });
});

it.each(["glass", "Aqua", "1"])(
  "rejects unknown theme %s and lists the valid ones",
  async (value) => {
    const error = await loadError(`theme: ${value}\n`);
    expect(error.message).toBe("invalid homie config: theme must be one of: aqua, metal");
  },
);

describe("runtime behavior", () => {
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
