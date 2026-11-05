import type { FeedArticle, FeedResult } from "./types.ts";

export const MAX_FEEDS = 32;
export const MAX_FEED_ITEMS = 5;
export const FEED_FRESH_MS = 15 * 60_000;

export function compareFeedArticles(a: FeedArticle, b: FeedArticle) {
  return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
}

/** Give each source a turn; newer articles win extra slots and the five-source cutoff. */
export function balancedFeedHeadlines(feeds: FeedResult[]) {
  const queues = feeds.map((feed, order) => ({
    feed,
    order,
    count: 0,
    cursor: 0,
    articles: (feed.articles ?? [])
      .filter((article) => feedUrl(article.url) !== null)
      .toSorted(compareFeedArticles),
  }));
  const selected: Array<{ feed: FeedResult; article: FeedArticle; order: number }> = [];
  const seen = new Set<string>();
  while (selected.length < MAX_FEED_ITEMS) {
    for (const queue of queues) {
      while (queue.cursor < queue.articles.length && seen.has(queue.articles[queue.cursor].url))
        queue.cursor++;
    }
    const eligible = queues.filter((queue) => queue.cursor < queue.articles.length);
    eligible.sort(
      (a, b) =>
        a.count - b.count ||
        compareFeedArticles(a.articles[a.cursor], b.articles[b.cursor]) ||
        a.order - b.order,
    );
    const next = eligible[0];
    if (!next) break;
    const article = next.articles[next.cursor++];
    next.count++;
    seen.add(article.url);
    selected.push({ feed: next.feed, article, order: next.order });
  }
  return selected.sort((a, b) => compareFeedArticles(a.article, b.article) || a.order - b.order);
}

/** Feed targets and article links use bounded, credential-free HTTP(S) URLs. */
export function feedUrl(value: string, base?: string) {
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.href.length > 4096) return null;
    return url;
  } catch {
    return null;
  }
}
