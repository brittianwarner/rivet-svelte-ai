# Agent guide

This is a community-built Rivet Actors + SvelteKit starter and workspace Svelte adapter. Keep it easy to run, easy to learn from, and honest about its guarantees. These instructions apply throughout the repository; a more specific instruction file applies within its directory.

## Start with the relevant source

- Read `README.md` for setup and product behavior, `CONTRIBUTING.md` for contribution checks, and the nearest existing implementation before editing.
- Inspect the working tree first. Preserve unrelated changes and the user's running playground state. Do not clear browser storage or engine data to make a test pass.
- Use the checked-in manifests and `bun.lock` as the version authority. Do not replace current Rivet APIs with older examples from skills or tutorials.
- Keep changes focused. Fix the owning layer instead of adding duplicate state, speculative abstractions, or unrelated dependency upgrades.
- Maintain this guide when commands or architecture change. Link to detailed docs instead of copying them here; do not store task logs or temporary test results in instruction files.

## Repository map

Turborepo workspace. `apps/` are deployables; `packages/` are services and libraries. Each server-side service is its own package; `apps/server` composes them into one process and `ROLE` picks which ones run (see `servicesFor` in `packages/config`).

| Location                          | Responsibility                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/server/`                    | The one deployable: composes the services by `ROLE`; boot, drain, `dev.ts`; integration tests |
| `apps/web/`                       | SvelteKit app; built into a handler the server mounts                                         |
| `packages/actors/`                | Counter, session, chat actors and the registry; server-owned rules and data                   |
| `packages/entities/`              | User/organization/project/export actors, principals, access, `commit`, outbox                 |
| `packages/api/`                   | Elysia routes as plugins; dependencies injected, no environment reads                         |
| `packages/files/`                 | App file store: the api's bucket (`FILES_*`), a directory, or memory                          |
| `packages/rivet-engine/`          | Engine node from `S3_*`, the local engine, namespace bootstrap                                |
| `packages/rivet-edge/`            | The `/rivet` relay and scoped engine tokens (admin denied); the web → api forwarder           |
| `packages/config/`                | Environment, `ROLE` presets, structured logging                                               |
| `packages/wire/`                  | Browser-safe shared contracts, validation patterns, and limits                                |
| `packages/rivetkit-svelte/`       | Reusable Svelte adapter, public API, and lifecycle tests                                      |
| `packages/sveltekit-adapter-bun/` | Vendored SvelteKit adapter for Bun (excluded from Prettier)                                   |
| `apps/web/src/lib/view-models/`   | Browser connection ownership, actions, and reconnect snapshots                                |
| `apps/web/src/lib/components/`    | Svelte presentation and accessible controls                                                   |
| `tests/e2e/`, `tests/fixtures/`   | Browser acceptance and the local provider fixture                                             |

Package boundaries are enforced by `turbo boundaries` (part of `bun run validate`) through the `tags` in each package's `turbo.json`: `browser` packages (`wire`, `rivetkit-svelte`) may not depend on `server`, `actors` or `config` packages; `apps/web` may not depend on `server` packages and imports `@example/actors` for types only. New server code goes in the package that owns the concern, or a new package wired into `apps/server`; never into `apps/web`.

## Run and verify

Run commands from the repository root. Use Bun 1.4.4 or newer (`engines` in `package.json`). Bun manages the workspace and runs the server, engine launcher and tests; Node is not used. Do not introduce another lockfile.

```sh
bun install --frozen-lockfile
bun run dev                         # Vite :5173; api :3001 (/api, /rivet; restarts on save); engine :6440 (.rivet/engine)
WEB_PORT=5183 PORT=3011 ENGINE_PORT=6470 bun run dev   # beside another checkout
bun run check                       # TypeScript and Svelte diagnostics
bun run test                        # API and adapter unit tests
bun run build                       # Adapter and production web build
bun run validate                    # check + test + build
bun run format:check
bunx playwright install chromium    # Once per environment
bun run test:e2e:production          # Build + browser suites, including fake AI
bun run test:integration            # Real server + isolated engine, incl. restart and chat fixture
```

- For docs-only edits, check formatting, paths, and command accuracy; application tests are unnecessary unless behavior also changes.
- For code changes, run relevant checks and behavior tests. Add tests for changed contracts, races, cleanup, or recovery behavior rather than mirroring implementation details.
- For UI changes, test the production browser flow and inspect actual desktop and narrow mobile rendering, including empty, pending, failed, and full states where affected. A screenshot or HTTP 200 alone is not end-to-end evidence.
- For actor lifecycle or persistence changes, run `bun run test:integration` (real isolated engine, server restart). Distinguish a server restart from rotating engine nodes; for deploy behavior, rehearse with `deploy/rehearse-deploy.sh` and read `docs/deployment.md` before claiming recovery guarantees.
- Before a PR, follow `CONTRIBUTING.md`; `.github/workflows/ci.yml` is the CI contract. Report checks actually run, failures, and unverified behavior.
- Browser suites use web :5174, API :3002, and engine :6540–6542 by default. Run them sequentially. If another engine occupies those ports, use a free consecutive range, for example `E2E_ENGINE_PORT=6560 bun run test:e2e:production`. Do not stop an unrelated process to free a port. Integration tests use engines :6560/:6580/:6600 and servers :3010/:3030/:3050–3051.
- Use the local provider fixture for automated AI tests. Do not send paid model requests just to validate changes. Keep credentials out of logs, screenshots, browser bundles, and commits.

## Rivet and shared contracts

- Give independent entities their own keyed actors. Keep business rules on the server and validate action/HTTP input at runtime, even when TypeScript callers are typed.
- Persist data in the actor's SQLite database (`db` + `migrations()`). RivetKit 3.x deprecates `state`/`createState`, `c.kv`, queues, `connState`, `saveState` and `preventSleep`; do not add them. Never edit a shipped migration; add a new version. Use `c.vars` only for disposable runtime resources (sessions, timers, presence). Bound every table that grows and page reads of it.
- Write entity changes through `commit` (`packages/entities/src/store.ts`): checks inside the callback, never an await on another actor or `fetch` inside a transaction. Tell other actors through the outbox (`enqueue` in the transaction, `kickOutbox` after); handlers must be idempotent. Use `get`, not `getOrCreate`, for keys a caller can name.
- Reserve capacity before awaiting external work when concurrent actions can race. Define retry and idempotency behavior. Use a workflow (`run: workflow(...)`, see `project-export.ts`) for multi-step work that must resume after a crash; actor persistence alone does not make an external request or model stream durable.
- `docs/recipes.md` maps each pattern to its code and test. Update it when you add or move one.
- Keep session membership separate from counter state and connection status. Disconnect releases a local socket; removal updates the session registry; neither destroys the counter. Preserve Undo, cross-tab updates, intentionally empty sessions, and stable actor identity when changing these flows.
- Subscribe before fetching snapshots, reconcile stale/out-of-order responses, and release listeners and connections on teardown. Keep reconnect behavior covered by tests.
- Put shared DTOs and limits in `packages/wire`. Import the API registry into browser code with `import type`; never import server runtime modules or secrets into the web app.
- Entity actors use the hooks in `packages/entities/src/access.ts`: `authenticate` in `onBeforeConnect`, `trackSession`/`forgetSession` for `c.vars`, `caller`/`writer`/`requireSystem` in every action, and `publishTo` for events. Browsers open entities with `noCreate`; only the user actor and a new organization claim create. Never trust conn state or a raw id; never refuse in the organization's `canSubscribe` (it loops reconnects); never close sockets with an `auth.*` reason (the client stops reconnecting). See `docs/architecture.md#access-control`.
- Anonymous session IDs and `ACTOR_TOKEN` are demo conveniences, not user authentication or authorization. Consult `docs/deployment.md` before changing hosted access boundaries.

## Svelte and the playground

- Use Svelte 5 runes and event attributes: `$state`, `$derived`, `$props`, and `onclick`. Prefer derived state to effect-driven synchronization; reserve effects for external systems and lifecycle work.
- Resolve provider/context-backed view models during component initialization. Open browser connections in the browser lifecycle and return cleanup. Do not share mutable user state or live clients across SSR requests.
- Follow the adapter's ownership patterns: `useActor` for component-managed connections; `createReactiveActor` with explicit mount/release/dispose for view models. Check `packages/rivetkit-svelte/README.md` before inventing an API or updating the displayed examples.
- Keep the homepage focused on counters and sessions. Preserve the optional chat implementation for repository users without mounting it on the homepage unless requested.
- Reflect real actor state in the scene. Keep actor identity stable across additions/removals; show connected counts separately from saved membership. Keep labels readable and controls usable with keyboard, touch, reduced motion, and no WebGL.
- Prefer one clear control for each action and compact feedback. Avoid duplicate Add controls, overlapping labels, and unnecessary success banners. Keep recovery actions such as Undo near the action that needs them.
- The actor model uses native controls with CSS 3D depth. Keep values and labels in semantic HTML, preserve Flat view and reduced-motion behavior, and avoid adding a separate rendering loop or simulated traffic. Never display an unknown snapshot as a confirmed zero.
- When changing onboarding or examples, update the relevant docs and `apps/web/src/lib/visuals/actor-examples.ts` so the copy and code match the working package.

## Railway deployment

- Infrastructure lives in `.railway/railway.ts` using the official `railway/iac` SDK. Read `.railway/README.md` and `docs/deployment.md` before changing deployment behavior. Do not add legacy `railway.json` or `railway.toml` files.
- Confirm the linked project and environment with `railway status --json`, then review `bun run railway:plan`. Use a pinned plan for apply. Preserve existing resources and secrets; never automate destructive confirmation flags or log decrypted variables.
- One root `Dockerfile` builds the single image; `ROLE` selects web/api/engine (production, three services) or app/all. Web holds no secrets and forwards `/api` and `/rivet` to `API_URL`; the api holds `RIVET_TOKEN`, `ENTITY_SECRET` and the files bucket (`FILES_*`); the engine holds its own bucket (`S3_*`). Never put engine or file credentials on web. Keep `.env`, `.rivet/` and build artifacts out of the image context. Only port 8080 on `app` gets a public domain; never expose `api`, api_peer 6421, Guard 6420 or metrics.
- Deploys of `engine` rotate engine nodes. Keep its overlap ≥120 s and drain ≥660 s in `.railway/railway.ts`; shorter windows lost quorum permanently in rehearsal. `S3_ENDPOINT` must be https. Rehearse with `deploy/rehearse-deploy.sh`.
- Bytes that outlive a request (exports, uploads) go to `entityFiles()` / the `@example/files` store, never into actor SQLite or state; keep only the record in the actor.
- Validate hosted changes with `bun run test:deployment <web-origin>`. It writes its own acceptance counter and uses no paid AI. Test persistence against the same actor before/after a restart; process health alone is insufficient.

## Adapter and tooling boundaries

- `@rivetkit/svelte` is a workspace package; do not describe it as an official or published Rivet SDK. Preserve its Apache-2.0 license and upstream attribution; the starter itself is MIT.
- Adapter changes require checking public types, exports, lifecycle behavior, and package tests. Prefer an application-level fix when the adapter's reusable contract is already correct.
- Svelte workspaces use TypeScript 7 for checking through `@typescript/native` and retain TypeScript 6 for compiler-API compatibility. Do not remove that compatibility dependency without verifying the toolchain.
- Honor `.prettierignore`: adapter source is intentionally excluded from the starter-wide formatter. Match its local style rather than reformatting the package wholesale.
- Do not edit generated `build/`, `dist/`, `.svelte-kit/`, `.turbo/`, or test artifacts as source. Change dependencies through Bun and keep the lockfile consistent.
- Do not commit, push, merge, publish packages, or deploy unless the user requested that action. Finish by summarizing the change, validation, and material limitations.
