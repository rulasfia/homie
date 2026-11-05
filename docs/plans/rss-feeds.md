# RSS headlines

## Steps

- [x] Add feed configuration, shared response types, and validation.
- [x] Implement bounded RSS/Atom fetching, normalization, and server-side caching.
- [x] Expose the aggregate feeds endpoint with isolated per-feed failures.
- [x] Add the optional headlines section and independent refresh lifecycle.
- [x] Add focused tests, document configuration, and run project checks.

## Goal

Show recent articles from followed feeds when opening Homie in a new tab,
without delaying bookmarks or turning the dashboard into a full RSS reader.
Display up to five balanced headlines total, newest first, with the configured source name and
publication time. Clicking a headline opens the original article.

## Scope

- Support RSS 2.0 and Atom 1.0 using explicit feed URLs in YAML.
- Text-only headlines, using the existing section header, visibility toggle,
  typography, theme tokens, and keyboard focus styles.
- No article bodies, thumbnails, favicons, embedded HTML, read/unread state,
  subscription editor, feed discovery, notifications, or third-party proxy.
- No database, disk cache, browser headline persistence, or background scheduler.
- No feeds configured means no section and no browser feed requests.

## Configuration and defaults

```yaml
feeds:
  - name: Simon Willison
    url: https://simonwillison.net/atom/everything/
  - name: Example blog
    url: https://example.com/feed.xml
```

Add an optional `feeds` array to `HomieConfig`. Require a non-empty name and an
absolute HTTP(S) URL without embedded credentials. Reject duplicate normalized
feed URLs and configurations exceeding 32 feeds. Missing or empty arrays disable
the feature. Follow existing validation conventions: errors identify field paths,
not configuration values; returned config remains deep-frozen.

Start with internal constants, not additional tuning options:

- Freshness: 15 minutes, independent of `cacheTtlMs` and monitoring refreshes.
- Maximum concurrent upstream fetches: 4 across the server, not per request.
- Fetch timeout: 5 seconds per feed, covering redirects and body consumption.
- Maximum decompressed response body: 1 MiB, enforced while reading.
- Redirect limit: 3, same-origin only for v1. Configure the final canonical feed
  URL when a provider redirects across origins.
- Retry backoff after failures: 1, 2, 4, 8, then 15 minutes maximum.

These are proposed implementation defaults, not measured performance claims.

## Server design

### Fetch and normalize

Add a focused server feed module. Use native `fetch` and one maintained,
server-only XML parser dependency. Select its current supported version during
implementation and verify that DTDs/external entities can be rejected and entity
expansion is bounded. Do not write an XML parser or parse XML with regular
expressions. Do not import the parser from frontend or shared modules.

Normalize only the data needed for display: plain-text title, safe article URL,
and optional publication timestamp. Resolve relative links against the final feed
URL, including Atom `xml:base` where present. Prefer Atom alternate HTML links;
do not mistake self/enclosure links or RSS GUIDs for article URLs.

Skip entries without a usable title or HTTP(S) article link. Retain up to five
distinct usable articles per feed, ordered by publication time rather than XML
order. Keep undated articles in feed order after dated ones. Do not invent
publication times from fetch times. Treat future dates as
undated until that time. Sort dated headlines descending, undated ones last,
with configuration order as a stable tie-breaker.

Retain only the five normalized headlines per feed, validators, and cache metadata;
discard raw XML and article content. Cap retained title and validator lengths.
Reject malformed or unsupported documents without affecting other feeds.

### Demand-driven cache

Maintain one cache entry and at most one queued/in-flight fetch per configured
feed URL. All tabs and users share these entries and the concurrency limit.

- Fresh entry: return it without contacting the publisher.
- Expired entry: return its previous result immediately and start one refresh.
- Cold entry: queue one fetch and report a loading state immediately.
- Send `If-None-Match` and/or `If-Modified-Since` when validators are available.
  A `304` retains the previous parsed result and renews freshness, including a
  previously successful empty feed. A cold `304` is not a successful result.
- Failure: retain the last successful result, record a safe error state, and set
  the next eligible attempt using backoff. Requests during backoff do not retry.
- Reset backoff after a successful fetch or valid `304`.
- No periodic server refresh or retry timer. Requests trigger eligible work;
  already queued work may finish even if the requesting tab closes.
- Reconcile entries against the current config on API requests. Remove abandoned
  entries, cancel removed work, and prevent old completions from restoring it.
  Changing only a source name should not refetch its URL.

Use a feed-specific cache rather than changing monitoring cache semantics.
`server/cache.ts` currently removes failed entries and does not retain stale
values; copying that behavior would discard useful headlines.

Memory is bounded by configured feeds, the body limit, and global concurrency.
After a server restart the cache is cold. Accept loading headlines on that first
visit; the rest of Homie remains immediately usable.

### API contract

Add `GET /api/feeds` in `server/index.ts` and shared types in `shared/types.ts`.
The endpoint reads only configured feed URLs, never a client-supplied target.

Return `configured`, aggregate `refreshing`, and one result per configured feed.
Each result includes its stable identity, configured name, selected `articles` array when applicable,
last successful check time, and a discriminated state:

- `loading`: no successful result yet; work is queued or in flight.
- `ready`: successful feed with usable articles; its selected array may be empty when other sources fill the five slots.
- `empty`: successful feed without a usable article.
- `stale`: retained successful result after expiry or refresh failure.
- `unavailable`: no successful result and the fetch failed.

Distinguish an ongoing refresh from a failed refresh; stale data alone is not an
error. Include safe failure codes rather than raw upstream errors or XML.
Return `200` for partial and total upstream failures, represented per feed;
configuration/server failures follow existing API error handling. Return
`configured: false` and no results when disabled. Use `Cache-Control: no-store`;
the application cache owns freshness. Keep the service worker's existing API
network-only behavior.

Select at most five articles across all feeds before returning the response,
without truncating the cached candidates. Favor sources with the fewest slots
already assigned; newer next articles win ties, then configuration order.
Redistribute unused slots and deduplicate article URLs across sources. This
produces 5 from one source, 3/2 from two, and 2/2/1 from three when enough distinct
articles exist. With more than five sources, the five newest source headlines
win. Sort the final display by publication time, retaining deterministic ties.

## Frontend integration

- Add a small feed API client and focused view/refresh logic rather than growing
  the monitoring state machines. Render a compact semantic list, not cards.
- Place the optional `Headlines` section after Services. Reuse section visibility
  persistence. Show readable loading, empty, stale, and unavailable states per
  source without removing successful headlines from other sources.
- Render no more than five article rows. Keep failures from other sources in a
  separate, text-only status message, so errors do not consume article slots.
- Keyboard focus outlines the whole padded article row using the theme accent,
  with a subtle background tint and no animation. Retain native link outlines
  as a fallback in browsers without `:has` support.
- Start feed loading after the dashboard shell renders. Do not await it from
  `init`, `refreshAll`, ping checks, or the header's checked-time calculation.
- Include feed configuration in `RenderedConfig`, its storage validation, and
  config-change handling; bump the config cache version when its shape changes.
  Adding, removing, or renaming feeds takes effect without a server restart.
- Use one independent, visibility-aware 15-minute refresh schedule and
  `singleFlight`. Hidden tabs do not poll. Refresh on return when due.
- While the endpoint reports queued/in-flight work, schedule a lightweight
  follow-up API request every 2 seconds, stopping once settled or after a
  60-second observation window. This is temporary local API polling, not extra
  publisher fetching. Then resume the normal interval. Never create overlapping
  timers or let an obsolete config response restore removed feeds.
- The existing refresh button may request feed status independently, but must not
  bypass freshness/backoff or force publisher requests on every click.
- Preserve currently displayed headlines when the API is unreachable. Clearly
  distinguish publication time from last successful check time.
- Respect `openInNewTab`, reuse link safety/escaping helpers, and use semantic
  links and `<time>` elements. Dates need no continuously ticking timer.
- Handle long titles and narrow screens using existing tokens. No animations,
  images, remote fonts, or new frontend dependencies for this feature.

## Security and privacy

Feed configuration is trusted operator input; downloaded XML and browser storage
are untrusted. Allow configured private-network feeds, consistent with Homie's
homelab use case, but do not accept fetch destinations from API parameters.
Manually enforce HTTP(S), credential rejection, same-origin redirects, redirect
count, TLS verification, timeouts, and body limits on every request hop.

Never execute feed HTML or load its subresources. Decode supported text entities
without enabling DTD/entity expansion, escape titles for rendering, and validate
article URLs separately from feed URLs. Do not forward cookies, authorization,
or browser request headers to publishers. Logs must not contain raw XML, feed
URL query strings, or upstream response bodies.

Only the Homie server contacts publishers. Browsers contact a publisher when the
user opens an article, not when rendering a headline. Existing dashboard access
controls remain the deployment's responsibility; this feature adds no public
fetch proxy.

## Implementation and verification

1. Extend `shared/types.ts` and `server/config.ts`; test absent/valid feeds,
   invalid URLs and credentials, duplicates, limits, and immutable config.
2. Implement the server feed module with injected fetch/clock for focused tests.
   Use local fixtures for RSS and Atom, relative links, entities, unordered and
   missing dates, empty feeds, malformed XML, and unsafe article links.
3. Test caching and transport together: conditional `304`, stale preservation,
   shared in-flight work, global concurrency, backoff, timeout/size/redirect
   enforcement, and removal during an in-flight fetch. Tests must not contact
   real publishers or read `.env` files.
4. Wire `/api/feeds`; test disabled, loading, mixed-success, and failed-feed
   responses using the repository's existing API test patterns.
5. Add frontend integration and focused state/timer tests: no feeds means no
   requests; shell/checks do not wait; hidden tabs stop polling; pending work
   settles; config changes discard old responses; failed API calls keep titles.
6. Document the YAML example, 15-minute freshness, supported formats, bounds,
   canonical redirect URLs, server-restart behavior, and v1 exclusions in the
   project README. Do not modify the operator's active config to enable feeds.
7. Run `vp check` and `vp test`. Ask before any build, dev-server startup, or
   browser automation. With permission, inspect long titles, mobile layout,
   keyboard focus, theme compatibility, and frontend bundle impact.

## Acceptance criteria

- Configured RSS or Atom feeds yield up to five balanced, distinct headlines
  total, with slot redistribution and deterministic newest-first ordering.
- Opening multiple tabs shares upstream work; fresh feeds never refetch simply
  because another tab opens, and the feature does no work when unconfigured.
- Cold, slow, malformed, oversized, or unavailable feeds cannot block bookmarks,
  monitoring, or successful headlines from other feeds.
- Last successful results remain usable during refresh and outages, with honest
  freshness/error states and bounded retries, memory, and concurrency.
- No feed parser or article content enters the frontend bundle; no database,
  persistent headline cache, or always-running server polling is introduced.
