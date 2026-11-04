# homie

A lightweight, self-hosted homelab dashboard: bookmarks with ping checks, system
status from [Beszel](https://github.com/henrygd/beszel), and local or remote
Docker containers.

Built with vanilla TypeScript, a tiny Node.js server, and
[Vite+](https://viteplus.dev/).

## Features

- **Bookmark grid** with groups, descriptions, and custom icons
- **Live ping status** for any bookmark URL you allow-list; hover a down status to see why
- **Beszel integration** to show machine/system status
- **Docker containers** via local socket or remote `DOCKER_HOST`, with unhealthy ones flagged
- **No build needed for config changes** — `homie.config.yaml` is re-read on every request
- **Single Docker image** for easy self-hosting, on `amd64` and `arm64`

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

Drop `--env-file .env` if you don't use Beszel or a remote Docker host. Before
mounting the Docker socket, read [Security](#security).

### Docker Compose

```bash
# Build and run from source
docker compose up -d --build

# Or run a published image
HOMIE_IMAGE=ghcr.io/OWNER/homie:vX.Y.Z docker compose up -d --no-build
```

The compose file loads `.env` when it exists. Without one, the Beszel section
stays off and the Containers section uses the mounted Docker socket.

See `compose.yml` for configurable environment variables (`HOMIE_PORT`,
`HOMIE_CONFIG`, `DOCKER_SOCKET`, etc.).

## Configuration

Edit `homie.config.yaml` to define your groups and bookmarks. The file is
checked on every request and re-read when it changes, so edits take effect
immediately without a restart.
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
- `ping: true` — enable live status checks. Status below 400, 401, and 403 count
  as up (a service behind a login is reachable); 404, 5xx, timeouts, and network
  errors count as down
- `expectStatus` — optional non-empty list of HTTP status codes (100–599) that
  count as up, e.g. `[200, 404]`. When set, only these statuses are up.
  Redirects are followed, so 3xx codes never match
- `insecure: true` — skip TLS certificate verification for this bookmark's ping
  only, for services with self-signed certificates (default `false`). The check
  then cannot tell the real service from an impostor, so use it only on a network
  you trust. Redirects to other hosts are still verified. Prefer this over
  `NODE_TLS_REJECT_UNAUTHORIZED=0`, which disables verification for everything,
  including Beszel.

The dashboard gets every ping result from one `GET /api/pings` request, which
streams one NDJSON line per bookmark as its check finishes. The server picks the
URLs from `homie.config.yaml`, so only configured bookmarks are ever pinged.
Behind a reverse proxy, the response sets `x-accel-buffering: no` so nginx does
not buffer the stream. Image icons fall back to
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

## Security

homie has no login. Anyone who can open it sees your bookmarks, machine
addresses, and containers.

- Keep it on your LAN or VPN, or put it behind a reverse proxy that asks for a
  login (Authelia, Authentik, Caddy or nginx basic auth, Cloudflare Access).
- Don't expose port 3000 to the internet directly.

**The Docker socket.** Mounting `/var/run/docker.sock` gives homie full control of
Docker, which is root on the host. `:ro` doesn't change that: it only protects the
socket file, not the API behind it. homie only needs to list containers, so a
safer setup is [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy),
which allows just that:

```yaml
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:v0.5.0
    restart: unless-stopped
    environment:
      - CONTAINERS=1 # read-only container list; everything else is blocked
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro

  homie:
    # ...as in compose.yml, but remove the docker.sock volume and add:
    environment:
      - DOCKER_HOST=tcp://docker-socket-proxy:2375
```

The proxy isn't published on a host port, so only containers on the same compose
network can reach it.

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

On every `v*.*.*` tag, the included GitHub Actions workflow runs the CI checks
(`vp check`, `vp test`), then builds a `linux/amd64` and `linux/arm64` image and
pushes it to GitHub Container Registry. If the checks fail, nothing is published.

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

For public repositories the image can be pulled directly. For private
repositories, pullers need a GitHub PAT with `read:packages` (and `repo`) scope
and must run `docker login ghcr.io` first.

## License

[MIT](LICENSE)
