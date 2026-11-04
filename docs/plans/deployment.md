# Deployment packaging

## Status

Mostly done. Shipped: the multi-arch (`amd64`, `arm64`) image, `compose.yml`
with an optional `.env`, a healthcheck on `/api/config`, and the GHCR release
workflow, which runs the CI checks first. Not done: a `docker-socket-proxy`
sidecar in compose and Traefik labels.

## Goal

Make homie easy to deploy in a real homelab: a multi-arch image, a compose
stack, and sensible defaults.

## Proposed approach

1. **Multi-arch image** — extend the Dockerfile with `linux/amd64` and
   `linux/arm64` support using `docker buildx`.
2. **docker-compose.yml** — run homie plus optional docker-socket-proxy:
   - `homie` image
   - `docker-socket-proxy` sidecar (read-only container API access)
   - volume mounts for `homie.config.yaml` and `.env`
   - published port `3000`
3. **Healthcheck** — add a simple HTTP healthcheck endpoint or rely on the
   existing `/api/config` route.
4. **Optional Traefik labels** — include commented-out labels in compose for users
   who reverse-proxy with Traefik.
5. **GitHub Actions** — build and push images to GitHub Container Registry on tag.

## Open questions

- Do we publish an image publicly, or only document how users can build their own?
- Should we keep the final image based on `node:24-alpine` or use the slim
  `node:24-slim` for smaller size?
- How do we handle the `homie.config.yaml` file at first run? Document copying a
  template? Ship a default config in the image?
