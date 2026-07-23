# Remote Docker containers via Beszel

## Goal

Show Docker containers from every monitored machine (not just the host running
homie), without mounting any remote sockets. Beszel already tracks containers on
each agent, so we can reuse its data store.

## Proposed approach

1. Use the same `/api/systems` Beszel auth/token cache we already have.
2. Query Beszel's `container_stats` collection for each system:
   - `GET /api/collections/container_stats/records?filter=system='{id}'&sort=-created&perPage=1`
   - The record's `stats` array holds compact per-container stats:
     - `n` — container name
     - `c` — CPU percent
     - `m` — memory percent
     - `b` — network I/O bytes
3. Normalize the compact record into a `RemoteContainer` shape.
4. Add a new `/api/containers/remote` endpoint (or extend
   `/api/containers?source=beszel`) that returns `{ configured, bySystem: [...] }`.
5. Render a separate section or combine it with the local Docker container list.

## Open questions

- Does the current Beszel hub store container names even when the system is down?
  If not, we need to hide the whole system group or show a stale-state warning.
- Should we show the same CPU/mem meters as the Machines section, or keep the
  container list more compact (state + name + image)?
- Is it worth de-duplicating local containers that also appear from Beszel when
  homie and a Beszel agent run on the same machine?
- What is the exact shape of the compact `stats` array in recent Beszel versions?

## Data flow

```
frontend → /api/containers/remote
  server → beszel.ts (auth + cached token)
    → GET /api/collections/container_stats/records
    → normalize by system
  → frontend renders grouped list
```
