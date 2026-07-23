# Bookmark favicons

## Goal

Give each bookmark card a visual icon without requiring the user to manually
configure `icon` for every link. If a site has a usable favicon, use it; otherwise
fall back to a letter avatar based on the bookmark name.

## Proposed approach

1. **Frontend-only fetch** — the browser tries to download a site icon:
   - `https://{host}/favicon.ico` first
   - Then parse the target HTML for `<link rel="icon|shortcut icon|apple-touch-icon">`
   - Use the first icon found that is reachable (HTTP 200, image mime type)
2. **Fallback** — if no icon works, render a colored circle with the first letter
   of the bookmark name.
3. **Opt-out** — allow `icon: false` in the config to force a letter avatar even
   when an icon might be available.
4. **Privacy** — favicon discovery is done by the browser, so the homie server
   never contacts the bookmarked URLs. Some sites block cross-origin icon fetches;
   accept that gracefully.

## Open questions

- Should we cache successful favicon URLs to avoid repeated network/parse work?
- Is it acceptable to have a short list of hard-coded icon providers (e.g.
  DuckDuckGo/Google favicon services) for sites that hide their icons?
- Should letter avatars have deterministic colors based on the name, or a single
  neutral color from the design tokens?

## Rough UI sketch

- Keep the existing icon area size.
- On initial load, show a subtle skeleton/placeholder color.
- When favicon resolves, fade it in; if not, swap to the letter avatar.
