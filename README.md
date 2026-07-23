# homie

A lightweight, self-hosted homelab dashboard: bookmarks with ping checks, system
status from [Beszel](https://github.com/henrygd/beszel), and local Docker
containers.

## Quick start (local)

```bash
cp .env.example .env
# edit .env with your Beszel credentials (optional, enables Machines section)
vp install
vp run dev
```

## Run with Docker

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

If your host's Docker socket isn't root-owned, or you prefer not to mount the
socket directly, run a read-only proxy such as
[docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) and
point homie at it:

```bash
DOCKER_HOST=tcp://docker-socket-proxy:2375
```

## Configuration

`homie.config.yaml` controls bookmarks, groups, and ping behavior. It is
re-read on every request, so edits take effect immediately without a restart.
The path can be overridden with the `HOMIE_CONFIG` environment variable.

## Environment variables

See `.env.example` for all options.
