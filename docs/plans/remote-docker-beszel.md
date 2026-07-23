# Remote Docker containers via Beszel

## Goal

Show Docker containers from every monitored machine (not just the host running
homie), without mounting any remote sockets. Beszel already tracks containers on
each agent, so we can reuse its data store.

## Implemented approach

1. Reused the existing `/api/systems` Beszel auth/token cache.
2. Added `getRemoteContainers()` in `server/beszel.ts` that queries Beszel's
   `container_stats` collection for each system:
   - `GET /api/collections/container_stats/records?filter=system='{id}'&sort=-created&perPage=1`
   - The record's `stats` array holds compact per-container stats:
     - `n` — container name
     - `c` — CPU percent
     - `m` — memory percent
     - `b` — network I/O bytes
3. Normalized the compact record into a `RemoteContainer` shape in
   `shared/types.ts`.
4. Added `/api/containers/remote` returning `{ configured, bySystem: [...] }`.
5. Added `/api/containers/all` that merges local Docker containers and remote
   Beszel containers into a unified `UnifiedContainer` list.
6. Updated the frontend container table to render the unified list and added a
   dropdown filter to show containers from "All machines", "This machine", or a
   specific remote system.

## Decisions

- When a remote system is down, its containers are omitted from the list because
  Beszel's `container_stats` record for that system is empty/stale.
- Remote containers show a compact CPU/mem string in the Status column instead of
  the full meters used on the Machines cards.
- Local and remote containers are not de-duplicated for now. Local data is more
  complete (ports, image, status), while remote data is best for other machines.
- The compact `stats` array is treated defensively: only entries with a `n`
  string field are kept, and `c`/`m`/`b` are optional.

## Data flow

```
frontend → /api/containers/all
  server → docker.ts (local containers)
         → beszel.ts (auth + cached token)
           → GET /api/collections/container_stats/records
           → normalize by system
  → frontend renders unified, filterable table
```
