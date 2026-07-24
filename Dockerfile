# syntax=docker/dockerfile:1

# Pin the Vite+ toolchain image to the same major.minor.patch as the local
# vite-plus devDependency. Update both together when upgrading Vite+.
ARG VP_VERSION=0.2.5

# --- build stage: official Vite+ toolchain image ---
FROM ghcr.io/voidzero-dev/vite-plus:${VP_VERSION} AS build
WORKDIR /app

ARG HOMIE_VERSION=dev
ENV HOMIE_VERSION=${HOMIE_VERSION}

# The image runs as the non-root `vp` user; chown so `vp install` can write.
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version* ./
RUN vp install --frozen-lockfile

COPY --chown=vp:vp . .
RUN vp build

# --- deps stage: production-only dependencies ---
FROM ghcr.io/voidzero-dev/vite-plus:${VP_VERSION} AS deps
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version* ./
RUN vp install --frozen-lockfile --prod

# --- symlink stage: make "node" available on PATH for the distroless runtime ---
FROM alpine:latest AS node-symlink
RUN mkdir -p /usr/local/bin && ln -s /nodejs/bin/node /usr/local/bin/node

# --- runtime stage: distroless, no vp ---
FROM gcr.io/distroless/nodejs24-debian12 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Distroless keeps the Node binary at /nodejs/bin/node. Add a symlink on PATH so
# the CMD and the compose healthcheck can keep using "node".
COPY --from=node-symlink /usr/local/bin /usr/local/bin

COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/homie.config.yaml ./

# Runs as root so a mounted Docker socket is readable by the Containers section.
# Environment variables are supplied by the container runtime (docker run -e/--env-file,
# compose environment, Portainer stack env, etc.) — the image does not read a .env file.
EXPOSE 3000
ENTRYPOINT []
CMD ["node", "server/index.ts"]
