# syntax=docker/dockerfile:1

# Pin the Vite+ toolchain image to the same major.minor.patch as the local
# vite-plus devDependency. Update both together when upgrading Vite+.
ARG VP_VERSION=0.2.5

# --- build stage: official Vite+ toolchain image ---
FROM ghcr.io/voidzero-dev/vite-plus:${VP_VERSION} AS build
WORKDIR /app

# The image runs as the non-root `vp` user; chown so `vp install` can write.
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version* ./
RUN vp install --frozen-lockfile

COPY --chown=vp:vp . .
RUN vp build

# Export the exact Node.js resolved by vp so the runtime stage matches our pin.
RUN cp "$(vp env which node | head -1)" /tmp/node

# --- deps stage: production-only dependencies ---
FROM ghcr.io/voidzero-dev/vite-plus:${VP_VERSION} AS deps
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version* ./
RUN vp install --frozen-lockfile --prod

# --- runtime stage: small, glibc, no vp ---
FROM debian:bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# ca-certificates is required for HTTPS pings and Beszel/Docker API calls.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /tmp/node /usr/local/bin/node

COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/homie.config.yaml ./
COPY --from=build /app/.env.example ./

# Runs as root so a mounted Docker socket is readable by the Containers section.
EXPOSE 3000
CMD ["node", "--env-file-if-exists=.env", "server/index.ts"]
