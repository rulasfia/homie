# Custom bookmark icons via config

## Goal

Make bookmark icons richer and easier to maintain than pasting raw URLs into the
config, while keeping the current "it just works" defaults for simple cases.

## Current behavior

The `icon` field already accepts:

- A single emoji or letter (rendered as text)
- An absolute URL (`https://…`) pointing to any image
- A root-relative URL (`/icons/foo.svg`) pointing to a static file

## Proposed enhancements

1. **Local asset convention** — any value that is not a URL and not a single
   character is treated as a filename in a configured icon directory:
   - `icon: "proxmox"` → load `public/icons/proxmox.svg` or `.png`
   - Configurable via `iconDir` (default: `public/icons`)
2. **Brand-icon slugs** — allow `icon: "simple:github"` or `icon: "si:github"` to
   fetch from [Simple Icons](https://simpleicons.org/) at build or request time.
3. **Color hint** — support `iconColor: "#ff0000"` for SVG fill tinting or letter
   avatar background.
4. **Fallback chain** — try, in order:
   1. exact config value if it is a URL
   2. local asset file in `iconDir`
   3. brand-icon service slug
   4. first letter of the bookmark name

## Open questions

- Should icon fetching/caching happen at build time (fewer runtime deps) or
  runtime (more flexible, but adds network calls)?
- Do we ship a small default set of icons for common homelab apps (Plex, Traefik,
  Proxmox, Pi-hole, etc.) or leave that to the user?
- Is SVG inlining worth the XSS risk, or should we always render icons as `<img>`?
- Should the config schema change from a string `icon` to an object (`icon:
{ src, color }`) while still accepting strings for backwards compatibility?
