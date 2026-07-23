# syntax=docker/dockerfile:1

# Build the Vite frontend into dist/.
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# Runtime image. Runs as root so the mounted Docker socket is readable.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --prod --frozen-lockfile
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/homie.config.yaml ./
COPY --from=builder /app/.env.example ./
EXPOSE 3000
CMD ["node", "--env-file-if-exists=.env", "server/index.ts"]
