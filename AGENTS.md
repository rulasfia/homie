# homie — homelab dashboard

## Architecture

- **Frontend** (`src/`): Vanilla TypeScript, no framework. Built by Vite into `dist/`.
- **Backend** (`server/`): Node 24+ native HTTP server. TypeScript files run directly via `--experimental-strip-types` (no build step).
- **Shared types** (`shared/`): Imported by both frontend and server.
- `index.html` is the Vite entrypoint. `src/main.ts` is the frontend entry.

## Commands

| Action                    | Command                                     |
| ------------------------- | ------------------------------------------- |
| Install deps              | `vp install`                                |
| Dev (both frontend + API) | `vp run dev`                                |
| Dev (frontend only)       | `npm run dev:web`                           |
| Dev (API only)            | `npm run dev:api`                           |
| Build                     | `npm run build` (tsc check then Vite build) |
| Production start          | `npm run start`                             |
| Format / lint / typecheck | `vp check`                                  |
| Tests                     | `vp test`                                   |
| Generate PWA icons        | `pnpm generate-icons`                       |

## Important conventions

- **Config** (`homie.config.yaml`): `loadConfig()` checks the file per request and re-parses only when its mtime, size or inode changed. Edits take effect immediately, no restart needed. The returned config is deep-frozen and shared, so never mutate it.
- **Themes** (`theme` in the config, default `aqua`): `src/styles/app.css` and `tokens.css` hold layout and shared tokens; each theme is one stylesheet in `src/styles/themes/` that `loadThemeStyles()` in `src/theme.ts` imports dynamically, so only the configured theme is downloaded. Add a theme by adding its file there and its name to `THEMES` in `shared/themes.ts`. Light/dark (`data-theme`) is a per-browser setting that every theme supports.
- **Layout** (`render()` in `src/main.ts`): header bar, then `.app-columns` with a main column (Machines, Services, Containers) and a side column (Weather, Headlines). Put new glance-type sections in `.app-column-side`. When every side section is hidden, the main column takes the full width.
- **Pings come from the config only**: `GET /api/pings` streams NDJSON results for every `ping: true` bookmark in the config; no URL comes from the client.
- **Beszel and Docker sections are optional**: Frontend auto-hides sections when env vars are unset or socket is missing.
- **Env vars**: Passed in by the container runtime (`docker run -e`/`--env-file`, compose `environment`/`env_file`, Portainer stack env, etc.). The local dev / start scripts still auto-load `.env` for convenience.
- **Vite dev server** proxies `/api` to `http://localhost:3000`.

## TypeScript quirks

- `verbatimModuleSyntax: true` — use `import type` for type-only imports.
- `erasableSyntaxOnly: true` — no enums, no namespaces, no decorators.
- `allowImportingTsExtensions: true` — imports use `.ts` extension.

## Docker

The `Dockerfile` follows the Vite+ recommended multi-stage pattern:

- **Build stage**: `ghcr.io/voidzero-dev/vite-plus` (toolchain image, not runtime). Runs on `$BUILDPLATFORM`, so multi-arch builds only emulate the small later stages.
- **Deps stage**: separate production-only dependency install so the toolchain is not copied to runtime.
- **Runtime stage**: `gcr.io/distroless/nodejs24-debian12` with only the built app and production `node_modules` copied in; a symlink (made in the build stage) puts `node` on PATH for the CMD and the image `HEALTHCHECK`.

Build locally:

```bash
docker build -t homie .
```

The Vite+ toolchain image version is pinned via the `VP_VERSION` build arg; keep it in sync with the local `vite-plus` devDependency.

The service worker cache is versioned with the `HOMIE_VERSION` build arg. The GitHub Actions workflow passes the release tag automatically; for local builds you can override it:

```bash
docker build -t homie --build-arg HOMIE_VERSION=local .
```

### GHCR deployment

The repository includes a GitHub Actions workflow (`.github/workflows/docker.yml`) that runs the CI checks (`vp check`, `vp test`) and then builds and pushes a `linux/amd64` + `linux/arm64` image to GitHub Container Registry on every `v*.*.*` tag.

Required setup:

- The repository must have **Packages write** permission enabled for GitHub Actions (Settings → Actions → General → Workflow permissions).
- For a private image, users pulling it must authenticate with a PAT that has `read:packages` scope:
  `echo $CR_PAT | docker login ghcr.io -u USERNAME --password-stdin`

Run the published image:

```bash
# Minimal
docker run -d -p 3000:3000 ghcr.io/OWNER/homie:VERSION

# With config and env overrides
docker run -d -p 3000:3000 \
  -v /path/to/homie.config.yaml:/app/homie.config.yaml:ro \
  --env-file /path/to/.env \
  ghcr.io/OWNER/homie:VERSION

# With local Docker socket for the Containers section
docker run -d -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --env-file /path/to/.env \
  ghcr.io/OWNER/homie:VERSION
```

### Docker Compose

A `compose.yml` is included for local builds and GHCR deployments:

```bash
# Local build and run
docker compose up -d --build

# Deploy from GHCR (after logging in to ghcr.io)
HOMIE_IMAGE=ghcr.io/OWNER/homie:vX.Y.Z docker compose up -d --no-build
```

`.env` is loaded when present and optional otherwise.

Environment variables the compose file reads:

| Variable        | Default                | Purpose                                                                 |
| --------------- | ---------------------- | ----------------------------------------------------------------------- |
| `HOMIE_IMAGE`   | `homie:local`          | Image to run. Override with the GHCR tag for deployment.                |
| `HOMIE_PORT`    | `3000`                 | Host port mapped to the container.                                      |
| `HOMIE_CONFIG`  | `./homie.config.yaml`  | Path to your config file mounted read-only.                             |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket path; set `DOCKER_HOST` in `.env` to use a proxy instead. |

Mount `homie.config.yaml` as a read-only volume and optionally the Docker socket or a `DOCKER_HOST` env.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
