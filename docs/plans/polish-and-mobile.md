# Polish and mobile pass

## Goal

Make the dashboard feel intentional and responsive on phones, tablets, and
desktops.

## Proposed approach

1. **Transitions** — fade in new cards, pulse the status dot while pending, and
   animate meter width changes.
2. **Empty states** — nicer placeholder when there are no bookmarks, no Beszel
   systems, or no Docker containers. Show a short message and a hint about the
   matching `.env` variables.
3. **Mobile** —
   - Reduce header padding on small screens.
   - Stack the machine cards to one column.
   - Hide container ports/images on very narrow screens.
   - Ensure the refresh button is reachable with a thumb.
4. **Focus states** — visible keyboard focus rings for accessibility.
5. **Dark/light toggle** — optional manual toggle next to the refresh button
   instead of relying only on `prefers-color-scheme`.
6. **Status summary** — small header badge showing "X up / Y down" for pings and
   "X running / Y stopped" for containers.

## Open questions

- Do we want to store the manual theme preference in `localStorage`?
- Should there be a global compact mode (smaller cards) for dense dashboards?
- What is the maximum number of bookmarks we should optimize for? (e.g. 10 vs 50)
