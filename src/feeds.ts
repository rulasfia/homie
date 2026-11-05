import { balancedFeedHeadlines, FEED_FRESH_MS, MAX_FEED_ITEMS } from "../shared/feeds.ts";
import type { FeedConfig, FeedResult, FeedsResponse } from "../shared/types.ts";
import { singleFlight } from "./refresh.ts";
import { escapeHtml, safeNavigationUrl } from "./safety.ts";

const FOLLOW_UP_MS = 2000;
const OBSERVE_MS = 60_000;

function dateHtml(value: string, label: string, withTime = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (withTime) {
    options.hour = "2-digit";
    options.minute = "2-digit";
  }
  return `<time datetime="${escapeHtml(date.toISOString())}" title="${escapeHtml(`${label} ${date.toLocaleString()}`)}">${escapeHtml(date.toLocaleString(undefined, options))}</time>`;
}

/** Feed content stays text-only; every link and title is checked at the rendering boundary. */
export function feedRowsHtml(feeds: FeedResult[], openInNewTab: boolean) {
  const headlines = balancedFeedHeadlines(feeds);
  const rows = headlines.length
    ? headlines
    : feeds.slice(0, MAX_FEED_ITEMS).map((feed) => ({ feed, article: undefined }));
  const noted = new Set<string>();
  return rows
    .map(({ feed, article }) => {
      const url = article && safeNavigationUrl(article.url);
      const headline =
        article && url
          ? `<a class="feed-link" href="${escapeHtml(url)}" target="${openInNewTab ? "_blank" : "_self"}" rel="noopener noreferrer">${escapeHtml(article.title)}</a>`
          : `<span class="feed-note">${feed.state === "empty" || feed.state === "stale" ? "No articles yet." : feed.state === "loading" ? "Loading feed…" : "Feed unavailable."}</span>`;
      const published = article?.publishedAt ? dateHtml(article.publishedAt, "Published") : "";
      const stale =
        feed.state === "stale" && !noted.has(feed.id)
          ? `<span class="feed-note">${feed.refreshing ? "Updating…" : feed.error ? "Update failed." : "Cached headline."} Last checked ${dateHtml(feed.checkedAt, "Last checked", true)}.</span>`
          : "";
      noted.add(feed.id);
      return `<li class="feed-row"><span class="feed-source">${escapeHtml(feed.name)}</span><div class="feed-body">${headline}${stale}</div><span class="feed-date">${published}</span></li>`;
    })
    .join("");
}

/** Keep non-selected source failures visible without adding more article rows. */
export function feedStatusText(feeds: FeedResult[], warning: boolean) {
  const sources = balancedFeedHeadlines(feeds).length ? feeds : feeds.slice(MAX_FEED_ITEMS);
  const unavailable = sources
    .filter((feed) => feed.state === "unavailable" && !feed.refreshing)
    .map((feed) => feed.name);
  const failed = sources
    .filter(
      (feed) => feed.state === "stale" && feed.error && !feed.refreshing && !feed.articles?.length,
    )
    .map((feed) => feed.name);
  const loading = sources
    .filter((feed) => feed.state === "loading" || (feed.state === "unavailable" && feed.refreshing))
    .map((feed) => feed.name);
  const empty = sources.filter((feed) => feed.state === "empty").map((feed) => feed.name);
  return [
    warning ? "Could not update headlines." : "",
    unavailable.length ? `Unavailable feeds: ${unavailable.join(", ")}.` : "",
    failed.length ? `Update failed: ${failed.join(", ")}.` : "",
    loading.length ? `Loading feeds: ${loading.join(", ")}.` : "",
    empty.length ? `Empty feeds: ${empty.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Owns one visible-tab timer. Short polling exists only while server work is pending. */
export class FeedController {
  private feeds: FeedConfig[] = [];
  private results: FeedResult[] = [];
  private warning = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextAt = 0;
  private observingUntil = 0;
  private request: AbortController | undefined;
  private loadOnce = singleFlight(() => this.load());
  private fetcher: (signal: AbortSignal) => Promise<FeedsResponse>;
  private render: (results: FeedResult[], warning: boolean) => void;

  constructor(
    fetcher: (signal: AbortSignal) => Promise<FeedsResponse>,
    render: (results: FeedResult[], warning: boolean) => void,
  ) {
    this.fetcher = fetcher;
    this.render = render;
    document.addEventListener("visibilitychange", () => {
      clearTimeout(this.timer);
      if (!this.feeds.length || document.visibilityState === "hidden") return;
      if (Date.now() >= this.nextAt) this.refresh();
      else this.arm(this.nextAt - Date.now());
    });
  }

  configure(feeds: FeedConfig[] = []) {
    if (JSON.stringify(feeds) === JSON.stringify(this.feeds)) {
      this.render(this.results, this.warning);
      return;
    }
    this.generation++;
    this.request?.abort();
    clearTimeout(this.timer);
    const previous = new Map(this.results.map((feed) => [feed.id, feed]));
    this.feeds = feeds;
    this.results = feeds.map((feed) => {
      const saved = previous.get(feed.url);
      return saved
        ? { ...saved, name: feed.name }
        : { id: feed.url, name: feed.name, state: "loading", refreshing: true };
    });
    this.warning = false;
    this.render(this.results, false);
    // A previous configuration's in-flight promise must not swallow the new load.
    this.loadOnce = singleFlight(() => this.load());
    this.nextAt = 0;
    this.refresh();
  }

  refresh() {
    if (!this.feeds.length || document.visibilityState === "hidden") return;
    this.observingUntil = Date.now() + OBSERVE_MS;
    clearTimeout(this.timer);
    void this.loadOnce();
  }

  private arm(delay: number) {
    clearTimeout(this.timer);
    this.nextAt = Date.now() + delay;
    if (this.feeds.length && document.visibilityState !== "hidden") {
      this.timer = setTimeout(() => {
        if (!this.observingUntil) this.observingUntil = Date.now() + OBSERVE_MS;
        void this.loadOnce();
      }, delay);
    }
  }

  private async load() {
    const generation = this.generation;
    const request = new AbortController();
    this.request = request;
    let refreshing = false;
    try {
      const response = await this.fetcher(request.signal);
      if (generation !== this.generation) return;
      const configured = new Map(this.feeds.map((feed) => [feed.url, feed]));
      this.results = response.feeds
        .filter((feed) => configured.has(feed.id))
        .map((feed) => ({ ...feed, name: configured.get(feed.id)!.name }));
      this.warning = false;
      refreshing = response.refreshing;
    } catch {
      if (generation !== this.generation) return;
      this.warning = true;
      this.results = this.results.map((feed) =>
        feed.state === "loading"
          ? {
              id: feed.id,
              name: feed.name,
              state: "unavailable",
              refreshing: false,
              error: "network",
            }
          : feed,
      );
    }
    if (generation !== this.generation) return;
    this.render(this.results, this.warning);
    if (refreshing && Date.now() < this.observingUntil) this.arm(FOLLOW_UP_MS);
    else {
      this.observingUntil = 0;
      this.arm(FEED_FRESH_MS);
    }
  }
}
