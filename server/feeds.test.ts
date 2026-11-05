import { afterEach, expect, it, vi } from "vite-plus/test";
import { FEED_FRESH_MS } from "../shared/feeds.ts";
import { FeedCache } from "./feeds.ts";

const feeds = [{ name: "Blog", url: "https://blog.test/feed" }];
const xml =
  '<rss version="2.0"><channel><item><title>Hello</title><link>/hello</link><pubDate>2026-01-01</pubDate></item></channel></rss>';
const response = () =>
  new Response(xml, {
    headers: { etag: '"v1"', "last-modified": "Thu, 01 Jan 2026 00:00:00 GMT" },
  });

afterEach(() => vi.useRealTimers());

it("returns cold loading immediately, shares work, and reuses fresh results across tabs and renames", async () => {
  const fetcher = vi.fn(async () => response());
  const cache = new FeedCache(fetcher);
  expect(cache.get(feeds)).toMatchObject({ refreshing: true, feeds: [{ state: "loading" }] });
  cache.get(feeds);
  await vi.waitFor(() => expect(cache.get(feeds).feeds[0].state).toBe("ready"));
  expect(cache.get([{ ...feeds[0], name: "Renamed" }]).feeds[0]).toMatchObject({
    name: "Renamed",
    articles: [{ title: "Hello" }],
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("serves stale headlines immediately and renews validators on 304", async () => {
  let now = Date.parse("2026-11-05");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response())
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  const cache = new FeedCache(fetcher, () => now);
  cache.get(feeds);
  await vi.waitFor(() => expect(cache.get(feeds).refreshing).toBe(false));
  now += FEED_FRESH_MS;
  expect(cache.get(feeds).feeds[0]).toMatchObject({
    state: "stale",
    refreshing: true,
    articles: [{ title: "Hello" }],
  });
  await vi.waitFor(() => expect(cache.get(feeds).feeds[0].state).toBe("ready"));
  expect(fetcher).toHaveBeenLastCalledWith(
    feeds[0].url,
    expect.objectContaining({
      redirect: "manual",
      credentials: "omit",
      headers: expect.objectContaining({
        "if-none-match": '"v1"',
        "if-modified-since": "Thu, 01 Jan 2026 00:00:00 GMT",
      }),
    }),
  );
});

it("preserves a stale success on failure and backs off until demand retries", async () => {
  let now = Date.parse("2026-11-05");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response())
    .mockRejectedValue(new Error("private upstream detail"));
  const cache = new FeedCache(fetcher, () => now);
  cache.get(feeds);
  await vi.waitFor(() => expect(cache.get(feeds).refreshing).toBe(false));
  now += FEED_FRESH_MS;
  cache.get(feeds);
  await vi.waitFor(() => expect(cache.get(feeds).refreshing).toBe(false));
  expect(cache.get(feeds).feeds[0]).toMatchObject({
    state: "stale",
    error: "network",
    articles: [{ title: "Hello" }],
  });
  expect(JSON.stringify(cache.get(feeds))).not.toContain("private upstream detail");
  now += 59_999;
  cache.get(feeds);
  expect(fetcher).toHaveBeenCalledTimes(2);
  now++;
  cache.get(feeds);
  await vi.waitFor(() => expect(cache.get(feeds).refreshing).toBe(false));
  expect(fetcher).toHaveBeenCalledTimes(3);
  now += 60_000;
  cache.get(feeds);
  expect(fetcher).toHaveBeenCalledTimes(3);
  now += 60_000;
  fetcher.mockResolvedValue(response());
  cache.get(feeds);
  await vi.waitFor(() => expect(cache.get(feeds).feeds[0].state).toBe("ready"));
});

it("handles successful empty feeds and their 304s, but rejects a cold 304", async () => {
  let now = Date.parse("2026-11-05");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('<rss version="2.0"><channel/></rss>'))
    .mockResolvedValue(new Response(null, { status: 304 }));
  const cache = new FeedCache(fetcher, () => now);
  cache.get(feeds);
  await vi.waitFor(() => expect(cache.get(feeds).feeds[0].state).toBe("empty"));
  now += FEED_FRESH_MS;
  cache.get(feeds);
  await vi.waitFor(() => expect(cache.get(feeds).feeds[0].state).toBe("empty"));
  const cold = new FeedCache(fetcher);
  cold.get(feeds);
  await vi.waitFor(() =>
    expect(cold.get(feeds).feeds[0]).toMatchObject({ state: "unavailable", error: "http" }),
  );
});

it("bounds concurrency globally and cancels removed queued and active work", async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    name: `Blog ${i}`,
    url: `https://blog.test/${i}`,
  }));
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn<typeof fetch>(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        const signal = options!.signal!;
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const cache = new FeedCache(fetcher);
  cache.get(many);
  cache.get(many);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(cache.get([])).toEqual({ configured: false, refreshing: false, feeds: [] });
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  await vi.waitFor(() => expect(cache.get([]).refreshing).toBe(false));
  expect(fetcher).toHaveBeenCalledTimes(4);
  fetcher.mockResolvedValue(response());
  cache.get([many[0]]);
  await vi.waitFor(() => expect(cache.get([many[0]]).feeds[0].state).toBe("ready"));
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it.each([
  ["http", () => new Response(null, { status: 503 })],
  ["invalid-feed", () => new Response("<html>bad</html>")],
  ["too-large", () => new Response("x".repeat(1_048_577))],
  [
    "redirect",
    () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
  ],
  [
    "redirect",
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://user:secret@blog.test/private" },
      }),
  ],
] as const)("isolates %s failure from a healthy feed", async (error, fail) => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    url === "https://blog.test/bad" ? fail() : response(),
  );
  const cache = new FeedCache(fetcher);
  const configured = [...feeds, { name: "Bad", url: "https://blog.test/bad" }];
  cache.get(configured);
  await vi.waitFor(() => expect(cache.get(configured).refreshing).toBe(false));
  expect(cache.get(configured).feeds).toMatchObject([
    { state: "ready" },
    { state: "unavailable", error },
  ]);
});

it("follows bounded same-origin redirects and uses their final URL for relative articles", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(null, { status: 301, headers: { location: "/canonical/feed" } }),
    )
    .mockResolvedValueOnce(new Response(xml.replace("/hello", "hello")));
  const cache = new FeedCache(fetcher);
  cache.get(feeds);
  await vi.waitFor(() => expect(cache.get(feeds).refreshing).toBe(false));
  expect(cache.get(feeds).feeds[0].articles?.[0]?.url).toBe("https://blog.test/canonical/hello");
  fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { location: "/loop" } }));
  const looping = new FeedCache(fetcher);
  looping.get(feeds);
  await vi.waitFor(() => expect(looping.get(feeds).refreshing).toBe(false));
  expect(looping.get(feeds).feeds[0]).toMatchObject({ state: "unavailable", error: "redirect" });
  expect(fetcher).toHaveBeenCalledTimes(6);
});

it("sends validators only to the resource that issued them", async () => {
  let now = Date.parse("2026-11-05");
  const redirect = () => new Response(null, { status: 301, headers: { location: "/canonical" } });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(redirect())
    .mockResolvedValueOnce(response())
    .mockResolvedValueOnce(redirect())
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  const cache = new FeedCache(fetcher, () => now);
  cache.get(feeds);
  await vi.waitFor(() => expect(cache.get(feeds).refreshing).toBe(false));
  now += FEED_FRESH_MS;
  cache.get(feeds);
  await vi.waitFor(() => expect(cache.get(feeds).refreshing).toBe(false));
  expect(fetcher.mock.calls[2][1]?.headers).not.toHaveProperty("if-none-match");
  expect(fetcher.mock.calls[3][1]?.headers).toHaveProperty("if-none-match", '"v1"');
  expect(cache.get(feeds).feeds[0].state).toBe("ready");
});

it("keeps source metadata in config order while selecting dated and undated articles", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async (url) =>
      new Response(url === feeds[0].url ? xml.replace("<pubDate>2026-01-01</pubDate>", "") : xml),
  );
  const cache = new FeedCache(fetcher);
  const configured = [
    ...feeds,
    { name: "Second", url: "https://second.test/" },
    { name: "Third", url: "https://third.test/" },
  ];
  cache.get(configured);
  await vi.waitFor(() => expect(cache.get(configured).refreshing).toBe(false));
  expect(cache.get(configured).feeds.map((feed) => feed.name)).toEqual(["Blog", "Second", "Third"]);
});

it("sends at most five balanced articles but retains candidates for later config changes", async () => {
  const configured = [...feeds, { name: "Second", url: "https://second.test/feed" }];
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        `<rss version="2.0"><channel>${Array.from(
          { length: 8 },
          (_, index) =>
            `<item><title>Article ${index}</title><link>/article/${index}</link><pubDate>2026-10-${20 - index}</pubDate></item>`,
        ).join("")}</channel></rss>`,
      ),
  );
  const cache = new FeedCache(fetcher);
  cache.get(configured);
  await vi.waitFor(() => expect(cache.get(configured).refreshing).toBe(false));
  const result = cache.get(configured);
  expect(result.feeds.map((feed) => feed.articles?.length ?? 0)).toEqual([3, 2]);
  expect(result.feeds.flatMap((feed) => feed.articles ?? [])).toHaveLength(5);
  expect(cache.get([configured[1]]).feeds[0].articles).toHaveLength(5);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("times out body consumption and releases queue capacity", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(async () => new Response(new ReadableStream({ start() {} })))
    .mockResolvedValue(response());
  const cache = new FeedCache(fetcher);
  cache.get(feeds);
  await vi.advanceTimersByTimeAsync(5000);
  expect(cache.get(feeds).feeds[0]).toMatchObject({
    state: "unavailable",
    error: "timeout",
    refreshing: false,
  });
  cache.get([...feeds, { name: "Next", url: "https://blog.test/next" }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    cache
      .get([...feeds, { name: "Next", url: "https://blog.test/next" }])
      .feeds.some((feed) => feed.state === "ready"),
  ).toBe(true);
});
