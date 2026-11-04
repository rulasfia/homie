# syntax=docker/dockerfile:1

# Pin the Vite+ toolchain image to the same major.minor.patch as the local
# vite-plus devDependency. Update both together when upgrading Vite+.
ARG VP_VERSION=0.2.5

# --- build stage: official Vite+ toolchain image ---
# Runs natively on the builder: dist/ is static JS and CSS, the same for every
# platform, so a multi-arch build doesn't emulate the slow part.
FROM --platform=$BUILDPLATFORM ghcr.io/voidzero-dev/vite-plus:${VP_VERSION} AS build
WORKDIR /app

ARG HOMIE_VERSION=dev
ENV HOMIE_VERSION=${HOMIE_VERSION}

# The image runs as the non-root `vp` user; chown so `vp install` can write.
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version* ./
RUN vp install --frozen-lockfile

COPY --chown=vp:vp . .
RUN vp build
# Distroless keeps the Node binary at /nodejs/bin/node. Prepare a symlink to it so
# the runtime stage can put "node" on PATH without pulling another base image.
RUN mkdir -p /tmp/node-bin && ln -s /nodejs/bin/node /tmp/node-bin/node

# --- deps stage: production-only dependencies ---
FROM ghcr.io/voidzero-dev/vite-plus:${VP_VERSION} AS deps
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version* ./
RUN vp install --frozen-lockfile --prod

# --- runtime stage: distroless, no vp ---
FROM gcr.io/distroless/nodejs24-debian12 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# "node" on PATH for the CMD and the healthcheck (symlink made in the build stage).
COPY --from=build /tmp/node-bin /usr/local/bin

COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/homie.config.yaml ./

# Runs as root so a mounted Docker socket is readable by the Containers section.
# See "Security" in the README for a safer setup with docker-socket-proxy.
# Environment variables are supplied by the container runtime (docker run -e/--env-file,
# compose environment, Portainer stack env, etc.); the image does not read a .env file.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch(`http://localhost:${process.env.PORT || 3000}/api/config`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT []
CMD ["node", "server/index.ts"]
