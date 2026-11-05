import { balancedFeedHeadlines, FEED_FRESH_MS, feedUrl } from "../shared/feeds.ts";
import type {
  FeedArticle,
  FeedConfig,
  FeedError,
  FeedResult,
  FeedsResponse,
} from "../shared/types.ts";
import { parseFeed } from "./feed-parser.ts";

const MAX_BODY_BYTES = 1_048_576;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const CONCURRENCY = 4;

class FeedFailure extends Error {
  code: FeedError;
  constructor(code: FeedError) {
    super(code);
    this.code = code;
  }
}

interface FeedEntry {
  url: string;
  articles?: FeedArticle[];
  checkedAt?: number;
  nextAttempt: number;
  failures: number;
  error?: FeedError;
  etag?: string;
  modified?: string;
  validatorUrl?: string;
  pending?: AbortController;
}

async function readBody(response: Response, signal: AbortSignal) {
  if (!response.body) throw new FeedFailure("invalid-feed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new FeedFailure("too-large");
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

function validator(value: string | null) {
  return value && value.length <= 1024 ? value : undefined;
}

/** One demand-driven cache/queue for the whole server; requests never await publishers. */
export class FeedCache {
  private entries = new Map<string, FeedEntry>();
  private queue: FeedEntry[] = [];
  private active = 0;
  private fetcher: typeof fetch;
  private now: () => number;

  constructor(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.fetcher = fetcher;
    this.now = now;
  }

  get(feeds: FeedConfig[] = []): FeedsResponse {
    const urls = new Set(feeds.map((feed) => feed.url));
    for (const [url, entry] of this.entries) {
      if (!urls.has(url)) {
        entry.pending?.abort();
        this.entries.delete(url);
      }
    }
    this.queue = this.queue.filter((entry) => this.entries.get(entry.url) === entry);
    const now = this.now();
    const results = feeds.map((feed): FeedResult => {
      let entry = this.entries.get(feed.url);
      if (!entry) {
        entry = { url: feed.url, nextAttempt: 0, failures: 0 };
        this.entries.set(feed.url, entry);
      }
      if (!entry.pending && now >= entry.nextAttempt) {
        entry.pending = new AbortController();
        this.queue.push(entry);
      }
      const common = { id: feed.url, name: feed.name, refreshing: !!entry.pending };
      if (entry.checkedAt === undefined) {
        return entry.error
          ? { ...common, state: "unavailable", error: entry.error }
          : { ...common, state: "loading" };
      }
      const checkedAt = new Date(entry.checkedAt).toISOString();
      if (now >= entry.checkedAt + FEED_FRESH_MS || entry.error) {
        return {
          ...common,
          state: "stale",
          articles: entry.articles,
          checkedAt,
          error: entry.error,
        };
      }
      return entry.articles?.length
        ? { ...common, state: "ready", articles: entry.articles, checkedAt }
        : { ...common, state: "empty", checkedAt };
    });
    this.drain();
    // Keep the cache's five candidates per source, but send only five articles total.
    const selected = balancedFeedHeadlines(results);
    const visible = results.map((feed) =>
      feed.articles
        ? {
            ...feed,
            articles: selected
              .filter((item) => item.feed.id === feed.id)
              .map((item) => item.article),
          }
        : feed,
    );
    return {
      configured: feeds.length > 0,
      refreshing: results.some((feed) => feed.refreshing),
      feeds: visible,
    };
  }

  private drain() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const entry = this.queue.shift()!;
      this.active++;
      void this.refresh(entry).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }

  private async refresh(entry: FeedEntry) {
    const controller = entry.pending!;
    const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);
    const signal = controller.signal;
    try {
      await this.fetchFeed(entry, signal);
      signal.throwIfAborted();
      entry.checkedAt = this.now();
      entry.nextAttempt = entry.checkedAt + FEED_FRESH_MS;
      entry.failures = 0;
      entry.error = undefined;
    } catch (error) {
      // Removed entries remain detached; their completion cannot recreate a cache entry.
      entry.error = signal.aborted
        ? "timeout"
        : error instanceof FeedFailure
          ? error.code
          : "network";
      entry.failures++;
      entry.nextAttempt =
        this.now() + Math.min(60_000 * 2 ** Math.min(entry.failures - 1, 4), FEED_FRESH_MS);
    } finally {
      clearTimeout(timer);
      entry.pending = undefined;
    }
  }

  private async fetchFeed(entry: FeedEntry, signal: AbortSignal) {
    const initial = feedUrl(entry.url);
    if (!initial) throw new FeedFailure("invalid-feed");
    const origin = initial.origin;
    let target = initial.href;
    for (let redirects = 0; ; redirects++) {
      const headers: Record<string, string> = {
        accept: "application/atom+xml, application/rss+xml, application/xml, text/xml",
      };
      // Validators belong to the final resource, not its redirecting URL or other paths.
      if (target === entry.validatorUrl) {
        if (entry.etag) headers["if-none-match"] = entry.etag;
        if (entry.modified) headers["if-modified-since"] = entry.modified;
      }
      const response = await this.fetcher(target, {
        headers,
        signal,
        redirect: "manual",
        credentials: "omit",
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        const next = location ? feedUrl(location, target) : null;
        if (!next || next.origin !== origin || redirects >= MAX_REDIRECTS)
          throw new FeedFailure("redirect");
        target = next.href;
        continue;
      }
      if (response.status === 304) {
        if (entry.checkedAt === undefined || target !== entry.validatorUrl)
          throw new FeedFailure("http");
        entry.etag = validator(response.headers.get("etag")) ?? entry.etag;
        entry.modified = validator(response.headers.get("last-modified")) ?? entry.modified;
        return;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new FeedFailure("http");
      }
      const body = await readBody(response, signal);
      try {
        entry.articles = parseFeed(body, target, this.now());
      } catch {
        throw new FeedFailure("invalid-feed");
      }
      entry.etag = validator(response.headers.get("etag"));
      entry.modified = validator(response.headers.get("last-modified"));
      entry.validatorUrl = target;
      return;
    }
  }
}
