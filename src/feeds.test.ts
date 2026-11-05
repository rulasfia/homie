import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { FEED_FRESH_MS } from "../shared/feeds.ts";
import type { FeedResult, FeedsResponse } from "../shared/types.ts";
import { FeedController, feedRowsHtml, feedStatusText } from "./feeds.ts";

const feeds = [{ name: "Blog", url: "https://blog.test/feed" }];
const ready: FeedResult = {
  id: feeds[0].url,
  name: "Blog",
  state: "ready",
  refreshing: false,
  checkedAt: "2026-11-05T12:00:00Z",
  articles: [
    { title: "Hello", url: "https://blog.test/hello", publishedAt: "2026-11-04T10:00:00Z" },
  ],
};
const settled: FeedsResponse = { configured: true, refreshing: false, feeds: [ready] };
const pending: FeedsResponse = {
  configured: true,
  refreshing: true,
  feeds: [{ id: feeds[0].url, name: "Blog", state: "loading", refreshing: true }],
};

function setup(
  fetcher = vi.fn<(signal: AbortSignal) => Promise<FeedsResponse>>().mockResolvedValue(settled),
) {
  const events = new EventTarget();
  const doc = {
    visibilityState: "visible",
    addEventListener: events.addEventListener.bind(events),
  };
  vi.stubGlobal("document", doc);
  const render = vi.fn();
  const controller = new FeedController(fetcher, render);
  const visibility = (value: string) => {
    doc.visibilityState = value;
    events.dispatchEvent(new Event("visibilitychange"));
  };
  return { controller, fetcher, render, visibility };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does no work without configured feeds, including manual and visibility refreshes", () => {
  const { controller, fetcher, visibility } = setup();
  controller.configure();
  controller.refresh();
  visibility("hidden");
  visibility("visible");
  expect(fetcher).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("follows pending work, stops fast polling once settled, and observes the next scheduled refresh", async () => {
  const { controller, fetcher, render } = setup();
  fetcher.mockResolvedValueOnce(pending).mockResolvedValue(settled);
  controller.configure(feeds);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(render).toHaveBeenLastCalledWith([ready], false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(pending).mockResolvedValue(settled);
  await vi.advanceTimersByTimeAsync(FEED_FRESH_MS - 60_000);
  expect(fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(1);
});

it("bounds temporary polling even when the server remains pending", async () => {
  const { controller, fetcher } = setup();
  fetcher.mockResolvedValue(pending);
  controller.configure(feeds);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(31);
  await vi.advanceTimersByTimeAsync(FEED_FRESH_MS - 1);
  expect(fetcher).toHaveBeenCalledTimes(31);
  expect(vi.getTimerCount()).toBe(1);
});

it("pauses when hidden and resumes due work on return", async () => {
  const { controller, fetcher, visibility } = setup();
  controller.configure(feeds);
  await vi.advanceTimersByTimeAsync(0);
  visibility("hidden");
  await vi.advanceTimersByTimeAsync(FEED_FRESH_MS * 2);
  controller.refresh();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  visibility("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
});

it("does not fetch an initially hidden tab until it becomes visible", async () => {
  const { controller, fetcher, visibility } = setup();
  visibility("hidden");
  controller.configure(feeds);
  expect(fetcher).not.toHaveBeenCalled();
  visibility("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("shares in-flight requests and preserves headlines on API failure", async () => {
  const { controller, fetcher, render } = setup();
  controller.configure(feeds);
  controller.refresh();
  controller.refresh();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(0);
  fetcher.mockRejectedValue(new Error("offline"));
  controller.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(render).toHaveBeenLastCalledWith([ready], true);
});

it("aborts removed configurations and ignores obsolete responses", async () => {
  let finish!: (value: FeedsResponse) => void;
  const { controller, fetcher, render } = setup();
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  controller.configure(feeds);
  const signal = fetcher.mock.calls[0][0];
  controller.configure([]);
  expect(signal.aborted).toBe(true);
  finish(settled);
  await vi.advanceTimersByTimeAsync(0);
  expect(render).toHaveBeenLastCalledWith([], false);
  expect(vi.getTimerCount()).toBe(0);
});

it("starts a replacement configuration without waiting for its obsolete request", async () => {
  const { controller, fetcher, render } = setup();
  fetcher.mockImplementationOnce(() => new Promise(() => {}));
  controller.configure(feeds);
  controller.configure([{ ...feeds[0], name: "Renamed" }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(render).toHaveBeenLastCalledWith([{ ...ready, name: "Renamed" }], false);
});

it("escapes titles and names, rejects unsafe links, and respects tab preference", () => {
  const dangerous = {
    ...ready,
    name: "<script>name</script>",
    articles: [{ ...ready.articles[0], title: "<img src=x onerror=alert(1)>" }],
  };
  const html = feedRowsHtml([dangerous], false);
  expect(html).toContain("&lt;img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<img");
  expect(html).toContain('target="_self"');
  expect(feedRowsHtml([ready], true)).toContain('target="_blank"');
  expect(
    feedRowsHtml([{ ...ready, articles: [{ title: "bad", url: "javascript:alert(1)" }] }], true),
  ).not.toContain("href=");
});

it("distinguishes publication dates, stale failures, loading, and successful empty feeds", () => {
  const stale: FeedResult = { ...ready, state: "stale", error: "network" };
  expect(feedRowsHtml([ready], true)).toContain("Published");
  expect(feedRowsHtml([stale], true)).toContain("Update failed.");
  expect(feedRowsHtml([stale], true)).toContain("Last checked");
  expect(feedRowsHtml(pending.feeds, true)).toContain("Loading feed");
  expect(
    feedRowsHtml(
      [
        {
          id: "empty",
          name: "Empty",
          state: "empty",
          checkedAt: ready.checkedAt,
          refreshing: false,
        },
      ],
      true,
    ),
  ).toContain("No articles yet.");
});

it("renders no more than five article rows and keeps other source failures in the status", () => {
  const many = {
    ...ready,
    articles: Array.from({ length: 8 }, (_, index) => ({
      ...ready.articles[0],
      title: `Article ${index}`,
      url: `https://blog.test/${index}`,
    })),
  };
  const failed: FeedResult = {
    id: "bad",
    name: "Failed source",
    state: "unavailable",
    error: "http",
    refreshing: false,
  };
  const html = feedRowsHtml([many, failed], true);
  expect(html.match(/class="feed-row"/g)).toHaveLength(5);
  expect(html.match(/class="feed-link"/g)).toHaveLength(5);
  expect(feedStatusText([many, failed], false)).toContain("Unavailable feeds: Failed source.");
  expect(feedStatusText([ready], false)).toBe("");
});
