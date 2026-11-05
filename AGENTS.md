# Agent guide

This is a community-built Rivet Actors + SvelteKit starter and workspace Svelte adapter. Keep it easy to run, easy to learn from, and honest about its guarantees. These instructions apply throughout the repository; a more specific instruction file applies within its directory.

## Start with the relevant source

- Read `README.md` for setup and product behavior, `CONTRIBUTING.md` for contribution checks, and the nearest existing implementation before editing.
- Inspect the working tree first. Preserve unrelated changes and the user's running playground state. Do not clear browser storage or engine data to make a test pass.
- Use the checked-in manifests and `bun.lock` as the version authority. Do not replace current Rivet APIs with older examples from skills or tutorials.
- Keep changes focused. Fix the owning layer instead of adding duplicate state, speculative abstractions, or unrelated dependency upgrades.
- Maintain this guide when commands or architecture change. Link to detailed docs instead of copying them here; do not store task logs or temporary test results in instruction files.

## Repository map

| Location                                           | Responsibility                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/api/src/actors/`                             | Counter, session, and optional chat actors; server-owned rules and state |
| `apps/api/src/actors.ts`                           | Actor registry and local engine setup                                    |
| `apps/api/src/app.ts`                              | Hono routes, validation, and HTTP boundaries                             |
| `apps/api/src/env.ts`, `auth.ts`, `model.ts`       | Configuration, demo connection checks, and provider selection            |
| `apps/web/src/routes/`                             | SSR page, layout, and API proxy                                          |
| `apps/web/src/lib/view-models/`                    | Browser connection ownership, actions, and reconnect snapshots           |
| `apps/web/src/lib/components/`                     | Svelte presentation and accessible controls                              |
| `apps/web/src/lib/visuals/`                        | Three.js scene and displayed Svelte code examples                        |
| `packages/wire/`                                   | Browser-safe shared contracts, validation patterns, and limits           |
| `packages/rivetkit-svelte/`                        | Reusable adapter, public API, and lifecycle tests                        |
| `tests/e2e/`, `tests/fixtures/`, `apps/api/tests/` | Browser acceptance, local provider fixture, and real-engine integration  |

## Run and verify

Run commands from the repository root. Use Node 26 and the Bun version pinned in `package.json` (currently 1.4.4). Bun manages the workspace; Node runs the API and native engine. Do not introduce another lockfile.

```sh
bun install --frozen-lockfile
bun run dev                         # Web :5173; API :3001; default engine :6440
bun run check                       # TypeScript and Svelte diagnostics
bun run test                        # API and adapter unit tests
bun run build                       # Adapter and production web build
bun run validate                    # check + test + build
bun run format:check
bunx playwright install chromium    # Once per environment
bun run test:e2e:production          # Build + browser suites, including fake AI
bun run test:restart                # Isolated API/runner restart acceptance
```

- For docs-only edits, check formatting, paths, and command accuracy; application tests are unnecessary unless behavior also changes.
- For code changes, run relevant checks and behavior tests. Add tests for changed contracts, races, cleanup, or recovery behavior rather than mirroring implementation details.
- For UI changes, test the production browser flow and inspect actual desktop and narrow mobile rendering, including empty, pending, failed, and full states where affected. A screenshot or HTTP 200 alone is not end-to-end evidence.
- For actor lifecycle or persistence changes, exercise a real isolated engine and the relevant restart test. Distinguish API/runner restart from full engine restart; read `docs/local-engine-recovery.md` and current test output before claiming recovery guarantees.
- Before a PR, follow `CONTRIBUTING.md`; `.github/workflows/ci.yml` is the CI contract. Report checks actually run, failures, and unverified behavior.
- Browser suites use web :5174, API :3002, and engine :6540–6542 by default. Run them sequentially. If another engine occupies those ports, use a free consecutive range, for example `E2E_ENGINE_PORT=6560 bun run test:e2e:production`. Do not stop an unrelated process to free a port. Restart-test ports are documented in `docs/local-engine-recovery.md`.
- Use the local provider fixture for automated AI tests. Do not send paid model requests just to validate changes. Keep credentials out of logs, screenshots, browser bundles, and commits.

## Rivet and shared contracts

- Give independent entities their own keyed actors. Keep business rules on the server and validate action/HTTP input at runtime, even when TypeScript callers are typed.
- Persist meaningful data in bounded `c.state`, or choose KV/SQLite for larger datasets. Use ephemeral variables only for disposable runtime resources. Bound histories, registries, queues, and retry metadata.
- Reserve capacity before awaiting external work when concurrent actions can race. Define retry and idempotency behavior; actor state persistence does not make an external request or model stream a durable workflow.
- Keep session membership separate from counter state and connection status. Disconnect releases a local socket; removal updates the session registry; neither destroys the counter. Preserve Undo, cross-tab updates, intentionally empty sessions, and stable actor identity when changing these flows.
- Subscribe before fetching snapshots, reconcile stale/out-of-order responses, and release listeners and connections on teardown. Keep reconnect behavior covered by tests.
- Put shared DTOs and limits in `packages/wire`. Import the API registry into browser code with `import type`; never import server runtime modules or secrets into the web app.
- Anonymous session IDs and `ACTOR_TOKEN` are demo conveniences, not user authentication or authorization. Consult `docs/deployment.md` before changing hosted access boundaries.

## Svelte and the playground

- Use Svelte 5 runes and event attributes: `$state`, `$derived`, `$props`, and `onclick`. Prefer derived state to effect-driven synchronization; reserve effects for external systems and lifecycle work.
- Resolve provider/context-backed view models during component initialization. Open browser connections in the browser lifecycle and return cleanup. Do not share mutable user state or live clients across SSR requests.
- Follow the adapter's ownership patterns: `useActor` for component-managed connections; `createReactiveActor` with explicit mount/release/dispose for view models. Check `packages/rivetkit-svelte/README.md` before inventing an API or updating the displayed examples.
- Keep the homepage focused on counters and sessions. Preserve the optional chat implementation for repository users without mounting it on the homepage unless requested.
- Reflect real actor state in the scene. Keep actor identity stable across additions/removals; show connected counts separately from saved membership. Keep labels readable and controls usable with keyboard, touch, reduced motion, and no WebGL.
- Prefer one clear control for each action and compact feedback. Avoid duplicate Add controls, overlapping labels, and unnecessary success banners. Keep recovery actions such as Undo near the action that needs them.
- Dispose Three.js resources, observers, and animation loops. Keep the scene browser-only and preserve its fallback UI.
- When changing onboarding or examples, update the relevant docs and `apps/web/src/lib/visuals/actor-examples.ts` so the copy and code match the working package.

## Railway deployment

- Infrastructure lives in `.railway/railway.ts` using the official `railway/iac` SDK. Read `.railway/README.md` and `docs/deployment.md` before changing deployment behavior. Do not add legacy `railway.json` or `railway.toml` files.
- Confirm the linked project and environment with `railway status --json`, then review `bun run railway:plan`. Use a pinned plan for apply. Preserve existing resources and secrets; never automate destructive confirmation flags or log decrypted variables.
- Web and API builds use the workspace root and separate Dockerfiles. Keep `.env`, local engine data, and build artifacts out of image contexts. The public web proxy reaches the API privately; only the web and Rivet gateway have public domains.
- Validate hosted changes with `bun run test:deployment <web-origin>`. It writes its own acceptance counter and uses no paid AI. Test persistence against the same actor before/after a restart; process health alone is insufficient.

## Adapter and tooling boundaries

- `@rivetkit/svelte` is a workspace package; do not describe it as an official or published Rivet SDK. Preserve its Apache-2.0 license and upstream attribution; the starter itself is MIT.
- Adapter changes require checking public types, exports, lifecycle behavior, and package tests. Prefer an application-level fix when the adapter's reusable contract is already correct.
- Svelte workspaces use TypeScript 7 for checking through `@typescript/native` and retain TypeScript 6 for compiler-API compatibility. Do not remove that compatibility dependency without verifying the toolchain.
- Honor `.prettierignore`: adapter source is intentionally excluded from the starter-wide formatter. Match its local style rather than reformatting the package wholesale.
- Do not edit generated `build/`, `dist/`, `.svelte-kit/`, `.turbo/`, or test artifacts as source. Change dependencies through Bun and keep the lockfile consistent.
- Do not commit, push, merge, publish packages, or deploy unless the user requested that action. Finish by summarizing the change, validation, and material limitations.
