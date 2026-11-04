# homie

A lightweight, self-hosted homelab dashboard: bookmarks with ping checks, system
status from [Beszel](https://github.com/henrygd/beszel), and local or remote
Docker containers.

Built with vanilla TypeScript, a tiny Node.js server, and
[Vite+](https://viteplus.dev/).

## Features

- **Bookmark grid** with groups, descriptions, and custom icons
- **Live ping status** for any bookmark URL you allow-list
- **Beszel integration** to show machine/system status
- **Docker containers** via local socket or remote `DOCKER_HOST`
- **No build needed for config changes** — `homie.config.yaml` is re-read on every request
- **Single Docker image** for easy self-hosting

## Quick start

### Local development

```bash
cp .env.example .env
# edit .env with your optional Beszel / Docker settings
vp install
vp run dev
```

Then open `http://localhost:5173`. The Vite dev server proxies `/api` to the
backend on `http://localhost:3000`.

### Docker

```bash
docker build -t homie .
docker run -d \
  --name homie \
  -p 3000:3000 \
  -v ./homie.config.yaml:/app/homie.config.yaml:ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --env-file .env \
  homie
```

### Docker Compose

```bash
# Build and run from source
docker compose up -d --build

# Or run a published image
HOMIE_IMAGE=ghcr.io/OWNER/homie:v0.1.1 docker compose up -d --no-build
```

See `compose.yml` for configurable environment variables (`HOMIE_PORT`,
`HOMIE_CONFIG`, `DOCKER_SOCKET`, etc.).

## Configuration

Edit `homie.config.yaml` to define your groups and bookmarks. The file is
re-read on every request, so changes take effect immediately without a restart.
The path can be overridden with the `HOMIE_CONFIG` environment variable.

Bookmarks open in a new tab by default. To open them in the current tab, set
this top-level option and reload the dashboard:

```yaml
openInNewTab: false
```

Each bookmark can have:

- `name` — display title
- `url` — target URL
- `description` — optional subtitle
- `icon` — emoji, single letter, absolute image URL, or root-relative path
- `ping: true` — enable live status checks

Only URLs listed in `homie.config.yaml` can be pinged. Image icons fall back to
the first letter of the bookmark name if the URL fails to load.

To add a copy-address button to a Beszel machine card, configure a machine whose
`name` exactly matches the name reported by Beszel:

```yaml
machines:
  - name: homeserver
    address: root@192.168.1.10
```

The `address` can be an IP address, hostname, or full SSH target. It is copied
as configured and is not used by the server to connect to the machine.

## Environment variables

Copy `.env.example` to `.env` and fill in the values you need.

| Variable          | Description                                                       |
| ----------------- | ----------------------------------------------------------------- |
| `PORT`            | Server port (default: `3000`)                                     |
| `HOMIE_CONFIG`    | Path to the YAML config file (default: `./homie.config.yaml`)     |
| `BESZEL_URL`      | URL of your Beszel hub (optional)                                 |
| `BESZEL_EMAIL`    | Beszel user email (optional)                                      |
| `BESZEL_PASSWORD` | Beszel user password (optional)                                   |
| `DOCKER_SOCKET`   | Local Docker socket path (default: `/var/run/docker.sock`)        |
| `DOCKER_HOST`     | Remote Engine API endpoint, e.g. `tcp://docker-socket-proxy:2375` |

The Beszel and Docker sections are optional. If the env vars are unset or the
socket is unreachable, the dashboard simply hides those sections.

## Debugging logs

The server writes one JSON record per line to the terminal or container logs.
To follow them with Docker:

```bash
docker logs --follow homie
# Or with Compose:
docker compose logs --follow homie
```

Each record has a timestamp, severity (`info`, `warn`, or `error`), and event.
Failed bookmark checks include the bookmark name, URL, HTTP status or network
error code, timeout, and latency. Beszel and Docker failures identify the source
and operation; per-machine failures include the machine name and ID. For example:

```json
{
  "timestamp": "2026-11-04T12:00:00.000Z",
  "level": "warn",
  "event": "bookmark.check.failed",
  "bookmark": "Jellyfin",
  "target": "http://jellyfin:8096/",
  "timeoutMs": 5000,
  "error": "TypeError -> ECONNREFUSED",
  "latencyMs": 4
}
```

- Identical health-check failures are logged at most once every five minutes per resource.
  Changed failures are logged immediately; recovery produces an `info` record.
  Successful checks otherwise stay quiet.
- Startup logs show whether Beszel and Docker are configured. Incomplete Beszel
  settings and explicitly configured but missing Docker sockets produce warnings.
- Beszel requests time out after five seconds. Bookmark timeouts use
  `pingTimeoutMs`; Docker requests retain their five-second inactivity timeout.
- Logs report Beszel machine status and local Docker unhealthy, restarting, or
  dead containers. Paused machines and intentionally stopped containers do not
  produce warnings. Homie does not probe individual container ports.
- Checks run when the dashboard requests data, not as a background monitoring
  service. Cached responses do not generate duplicate logs.
- URL credentials, query strings, and fragments are omitted. Raw error messages,
  stack traces, request headers, and response bodies are not logged because they
  may contain secrets. Logs still contain configured names, hosts, and URL paths;
  review them before sharing.

Common diagnostics: `ENOTFOUND` indicates DNS failure, `ECONNREFUSED` a refused
connection, `EACCES` socket permissions, and `TimeoutError`/`ETIMEDOUT` a timeout.
HTTP `401`/`403` suggests checking credentials or permissions; `404` for Beszel
container stats can indicate an older hub without that collection.

## Architecture

- **Frontend** (`src/`): Vanilla TypeScript, built by Vite into `dist/`.
- **Backend** (`server/`): Node.js native HTTP server. TypeScript files run
  directly with `--experimental-strip-types`, so there is no separate server build
  step.
- **Shared types** (`shared/`): Imported by both frontend and server.

## Development commands

| Action                      | Command          |
| --------------------------- | ---------------- |
| Install deps                | `vp install`     |
| Dev (frontend + API)        | `vp run dev`     |
| Dev (frontend only)         | `vp run dev:web` |
| Dev (API only)              | `vp run dev:api` |
| Build                       | `vp run build`   |
| Checks (format, lint, type) | `vp run check`   |
| Tests                       | `vp run test`    |

See `AGENTS.md` for more project conventions.

## Deployment

The included GitHub Actions workflow builds the image and pushes it to GitHub
Container Registry on every `v*.*.*` tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

For public repositories the image can be pulled directly. For private
repositories, pullers need a GitHub PAT with `read:packages` (and `repo`) scope
and must run `docker login ghcr.io` first.

## License

[MIT](LICENSE)
