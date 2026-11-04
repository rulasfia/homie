const CACHE_PREFIX = "homie-";
const CACHE_NAME = `${CACHE_PREFIX}__HOMIE_CACHE_VERSION__`;
const OFFLINE_URL = "/offline.html";

const STATIC_ASSETS = [
  OFFLINE_URL,
  "/manifest.json",
  "/favicon.svg",
  "/icons.svg",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
  "/icons/apple-touch-icon.png",
];

const CACHEABLE_ASSET_PATHS = new Set(STATIC_ASSETS);
// Vite emits hashed bundles under /assets/; PWA icons live under /icons/.
const CACHEABLE_ASSET_PREFIXES = ["/assets/", "/icons/"];

const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>homie is offline</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 2rem;
        background: #121315; color: #e7e9eb; font: 16px/1.5 "Arial Narrow", "Helvetica Neue", Arial, sans-serif; }
      main { max-width: 28rem; padding: 1.5rem 1.75rem; border-radius: 6px;
        background: linear-gradient(180deg, #2d3034, #222428); box-shadow: 0 14px 30px rgb(0 0 0 / 50%); }
      h1 { margin: 0 0 0.75rem; font-size: 1.5rem; letter-spacing: 0.2em; text-transform: uppercase; }
      p { margin: 0 0 1.25rem; color: #9aa1a8; }
      a { color: #ffb21e; }
    </style>
  </head>
  <body>
    <main>
      <h1>homie is offline</h1>
      <p>Live status needs a connection to your server. Reconnect and try again.</p>
      <a href="/">Reconnect</a>
    </main>
  </body>
</html>`;

function isCacheableAsset(pathname) {
  return (
    CACHEABLE_ASSET_PATHS.has(pathname) ||
    CACHEABLE_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function offlineApiResponse() {
  return new Response(JSON.stringify({ error: "offline" }), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function offlineFallbackResponse() {
  return new Response(OFFLINE_FALLBACK_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function offlinePageResponse() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(OFFLINE_URL);
    if (cached) return cached;
  } catch {
    // Cache storage is unavailable; use the inline fallback below.
  }
  return offlineFallbackResponse();
}

async function handleNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    return offlinePageResponse();
  }
}

function cacheResponse(cache, request, response) {
  if (!response.ok) return;
  return Promise.resolve()
    .then(() => cache.put(request, response.clone()))
    .catch(() => {
      // A full or unavailable cache must not fail an otherwise valid response.
    });
}

async function handleAsset(request) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return { response: cached };
  } catch {
    // Cache storage is unavailable; continue with the network.
  }

  const response = await fetch(request);
  const write = cache ? cacheResponse(cache, request, response) : undefined;
  return { response, write };
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API data is live and may contain private addresses; never store it.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request).catch(() => offlineApiResponse()));
    return;
  }

  // Navigation is network-first so online clients always get the current shell.
  // Keep it that way: a cached shell served after a deploy would reference hashed
  // assets the new server no longer has. The page gets its fast first paint from
  // the config saved in localStorage instead (src/config-cache.ts).
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (!isCacheableAsset(url.pathname)) return;
  const asset = handleAsset(request);
  event.respondWith(asset.then(({ response }) => response));
  // Register synchronously; keep writes alive without delaying the response.
  event.waitUntil(asset.then(({ write }) => write).catch(() => {}));
});
