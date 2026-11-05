import { expect, it } from "vite-plus/test";
import { balancedFeedHeadlines, compareFeedArticles } from "./feeds.ts";
import type { FeedResult } from "./types.ts";

function source(index: number, count = 5) {
  return {
    id: `https://feed.test/${index}`,
    name: `Feed ${index}`,
    state: "ready",
    refreshing: false,
    checkedAt: "2026-11-05T12:00:00Z",
    articles: Array.from({ length: count }, (_, article) => ({
      title: `Article ${index}/${article}`,
      url: `https://article.test/${index}/${article}`,
      publishedAt: new Date(Date.UTC(2026, 9, 20 + index - article)).toISOString(),
    })),
  } satisfies FeedResult;
}

it.each([
  [1, [5]],
  [2, [2, 3]],
  [3, [1, 2, 2]],
  [4, [1, 1, 1, 2]],
  [5, [1, 1, 1, 1, 1]],
  [8, [0, 0, 0, 1, 1, 1, 1, 1]],
] as const)(
  "balances five articles across %i sources and displays newest first",
  (count, allocation) => {
    const feeds = Array.from({ length: count }, (_, index) => source(index));
    const before = JSON.stringify(feeds);
    const selected = balancedFeedHeadlines(feeds);
    expect(selected).toHaveLength(5);
    expect(feeds.map((feed) => selected.filter((item) => item.feed.id === feed.id).length)).toEqual(
      allocation,
    );
    expect(selected.map((item) => item.article)).toEqual(
      selected.map((item) => item.article).toSorted(compareFeedArticles),
    );
    expect(JSON.stringify(feeds)).toBe(before);
  },
);

it("redistributes unused slots from sparse, empty, loading, and failed feeds", () => {
  const feeds: FeedResult[] = [
    source(0),
    source(1, 1),
    {
      id: "empty",
      name: "Empty",
      state: "empty",
      checkedAt: "2026-11-05T12:00:00Z",
      refreshing: false,
    },
    { id: "loading", name: "Loading", state: "loading", refreshing: true },
    { id: "failed", name: "Failed", state: "unavailable", error: "network", refreshing: false },
  ];
  const selected = balancedFeedHeadlines(feeds);
  expect(selected).toHaveLength(5);
  expect(selected.filter((item) => item.feed.id === feeds[0].id)).toHaveLength(4);
  expect(selected.filter((item) => item.feed.id === feeds[1].id)).toHaveLength(1);
});

it("deduplicates shared article URLs and backfills with other distinct articles", () => {
  const first = source(0);
  const second = source(1);
  second.articles[0] = first.articles[0];
  const selected = balancedFeedHeadlines([first, second]);
  expect(selected).toHaveLength(5);
  expect(new Set(selected.map((item) => item.article.url)).size).toBe(5);
  expect(selected.filter((item) => item.feed.id === first.id)).toHaveLength(3);
  expect(selected.filter((item) => item.feed.id === second.id)).toHaveLength(2);
});

it("orders dated articles before undated ones with stable config-order ties", () => {
  const first: FeedResult = source(0, 1);
  const second = source(1, 1);
  const third = source(2, 1);
  first.articles[0].publishedAt = undefined;
  third.articles[0].publishedAt = second.articles[0].publishedAt;
  expect(balancedFeedHeadlines([first, second, third]).map((item) => item.feed.id)).toEqual([
    second.id,
    third.id,
    first.id,
  ]);
});

it("returns only available safe articles when fewer than five exist", () => {
  const feed = source(0, 2);
  feed.articles[0].url = "javascript:alert(1)";
  expect(balancedFeedHeadlines([feed])).toHaveLength(1);
  expect(balancedFeedHeadlines([])).toEqual([]);
});
