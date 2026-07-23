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
| Tests                     | `vp test` (no tests exist yet)              |

## Important conventions

- **Config** (`homie.config.yaml`): Re-read per request — edits take effect immediately, no restart needed.
- **Ping endpoint is allowlisted**: Only URLs declared in the config can be pinged (`server/config.ts:17`).
- **Beszel and Docker sections are optional**: Frontend auto-hides sections when env vars are unset or socket is missing.
- **Env vars**: Loaded by `node --env-file-if-exists=.env`. See `.env.example`.
- **Vite dev server** proxies `/api` to `http://localhost:3000`.

## TypeScript quirks

- `verbatimModuleSyntax: true` — use `import type` for type-only imports.
- `erasableSyntaxOnly: true` — no enums, no namespaces, no decorators.
- `allowImportingTsExtensions: true` — imports use `.ts` extension.

## Docker

Build: `docker build -t homie .`
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
