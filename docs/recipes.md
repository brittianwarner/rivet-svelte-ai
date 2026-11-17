# Recipes

Each row is something a real app needs, the code in this repository that does it, and the test that proves it. Copy the pattern, not just the file: every recipe has a rule that keeps it correct, listed under it.

Paths are from the repository root. `server.test.ts` is `apps/server/tests/server.test.ts`, which runs against a real engine through the public `/rivet` edge (`bun run test:integration`). `data.spec.ts` is the browser suite in `tests/e2e/` (`bun run test:e2e`).

## Store data

| Need                                    | Code                                                                       | Proof                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A table per actor, created on first use | `db({ onMigrate: migrations(...) })` in `packages/actors/src/counter.ts`   | `counter.test.ts`                                                             |
| A schema with several tables            | `projectDb` in `packages/entities/src/actors/project.ts`                   | `server.test.ts` › entities                                                   |
| Carry pre-3.0 `c.state` into SQLite     | `packages/actors/src/legacy-state.ts`, each actor's version-1 migration    | `counter.test.ts`, `session.test.ts`, `chat.test.ts` › "the first migration…" |
| A change that cannot interleave         | One `UPDATE … RETURNING` (counter `increment`, project `toggleTask`)       | `counter.test.ts` › "concurrent increments…"                                  |
| A change across several rows            | `commit()` in `packages/entities/src/store.ts`                             | `packages/entities/src/store.test.ts`                                         |
| An audit trail with paged history       | `audit` table, `readAudit` / `readHistory` in `store.ts`; `getHistory`     | `store.test.ts` › "history pages backward…"                                   |
| A growing list, paged                   | `comments` table and `listComments` in `project.ts`                        | `server.test.ts` › "tasks carry paged comments…"                              |
| A file stored in the actor              | `files` table (BLOB) in `packages/entities/src/actors/project-export.ts`   | `server.test.ts` › "a CSV export runs as a workflow…"                         |
| Bounded data                            | `LIMITS` in `packages/entities/src/contracts.ts`, `assertRoom` in input.ts | `server.test.ts` › entities                                                   |

Rules:

- RivetKit 3.x deprecates `state`/`createState`, `c.kv`, queues, `connState` and `saveState`. New code uses `c.db`.
- Never edit a shipped migration. Add `version: 2`.
- Run every check that can fail inside `commit`'s callback. A throw rolls the whole change back, and nothing is published.
- Never await another actor or `fetch` inside a transaction. Do it before, or use the outbox.
- Bindings are `null`, numbers, strings, bigints or `Uint8Array`. Booleans are refused: use `bit()` from `input.ts`.
- Name every transaction (`commit(store, "task.add", …)`). Rivet labels its metrics with the name.

## Tell other actors

| Need                                     | Code                                                                     | Proof                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| A message that commits with the change   | `enqueue(tx, kind, target)` in `packages/entities/src/outbox.ts`         | `packages/entities/src/outbox.test.ts`                              |
| Retries with backoff that survive sleep  | `kickOutbox`, `onWake`, the `outbox` cron job, `drainOutbox` action      | `outbox.test.ts` › "a failure backs off…"                           |
| Many changes, one delivery of the latest | One outbox row per (kind, target), bumped by version                     | `outbox.test.ts` › "repeated changes…", "a change during delivery…" |
| Call an actor that may not exist         | `.get()` plus `unlessMissing()` in `packages/entities/src/peers.ts`      | `server.test.ts` › "deleting a project…"                            |
| Create a child actor idempotently        | `startProject` in `organization.ts` (`getOrCreate` + `initialize`)       | `server.test.ts` › "the organization indexes its projects…"         |
| Keep a copy in step with its owner       | user `applyOrganization` (`WHERE excluded.revision > …`), `applyProject` | `server.test.ts` › "an owner invites, the invitee accepts…"         |

Rules:

- Handlers must be idempotent: read fresh data and send it whole, so a retry or a late delivery is harmless.
- Use `get`, never `getOrCreate`, for any key a caller can name. A guessed key then finds nothing instead of starting an actor.
- Cross-actor calls can create circular types. Give those actions and hooks explicit return types, such as `onWake: (c): void => kick(c)`.

## Long-running and scheduled work

| Need                               | Code                                                                                 | Proof                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| A durable multi-step job           | `run: workflow(...)` in `project-export.ts`: `ctx.step`, `ctx.tryStep`               | `server.test.ts` › "a CSV export runs as a workflow…" |
| A durable timer                    | `ctx.sleepUntil("keep-file", expiresAt)` in `project-export.ts`                      | Same test: the export expires and its actor goes away |
| Recurring work                     | `c.cron.every({ name, interval, action })` in `outbox.ts`                            | `outbox.test.ts`                                      |
| Work that outlives the request     | `c.keepAwake(promise)` (outbox drain, chat turns)                                    | `chat.test.ts` › "wake runs an admitted turn…"        |
| Streaming output                   | `packages/actors/src/chat.ts`, `stream-response.ts`: deltas in `c.vars`, checkpoints | `stream-response.test.ts`, `chat.test.ts`             |
| A per-conversation spending budget | `turn_budget` table, `CHAT_TURNS_PER_HOUR` in `chat-limits.ts`                       | `chat.test.ts` › "each conversation has an hourly…"   |

Rules:

- A step may run more than once. Make each one safe to repeat.
- Steps get a context with `db`, `client()`, `broadcast` and `destroy()`. Do the work there, not between steps.
- `keepAwake` delays sleep. It does not survive a crash: persist what must resume, and pick it up in `onWake`.
- Cron intervals are at least 5 seconds. Delete the job when there is nothing left to do.

## Serve files and HTTP

| Need                         | Code                                                                       | Proof                                               |
| ---------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| Serve a download             | `onRequest` in `project-export.ts`; `ProjectViewModel.download` in the web | `server.test.ts`, `data.spec.ts` › "comments, …"    |
| Safe CSV                     | `cell()` in `project-export.ts`: quoting plus a `'` prefix on `= + - @`    | `server.test.ts` › "a CSV export…"                  |
| An HTTP route next to actors | `POST /api/counters/:name/increment` in `packages/api/src/app.ts`          | `server.test.ts` › "actions, events, and the HTTP…" |

Rules:

- `onRequest` runs after `onBeforeConnect`, so the same access check covers HTTP and sockets.
- Send `content-disposition: attachment`, `cache-control: private, no-store` and `x-content-type-options: nosniff` with user data.

## Users, access, and live views

| Need                          | Code                                                                        | Proof                                                          |
| ----------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Sign in and signed principals | `packages/entities/src/principal.ts`, `POST /api/entities/sign-in`          | `principal.test.ts`, `server.test.ts` › "connections without…" |
| Gate the socket               | `authenticate` in `onBeforeConnect` (`access.ts`)                           | `access.test.ts`                                               |
| Roles and permissions         | `PERMISSIONS` and `can()` in `contracts.ts`; `authorize` in a transaction   | `contracts.test.ts`                                            |
| Ask the owner on every call   | `roleIn` / `allow` in `project.ts` (`organization.projectRole`)             | `server.test.ts` › "open sockets only hear about…"             |
| Send events only to readers   | `publishTo(c, canRead)` in `access.ts`; `canSubscribe` on events            | `access.test.ts` › "publishTo reaches readers…"                |
| Revoke access on open sockets | `revokeAccess` in `project.ts`, close reason `user.access_revoked`          | `data.spec.ts` › "two people share an organization…"           |
| Token expiry and reconnect    | `trackSession` timer, `user.session_expired`, `getParams` in the view model | `server.test.ts` › "a socket closes when its token expires…"   |
| Per-person write budget       | `writer(c)` in `access.ts`                                                  | `server.test.ts` › "each caller has a write budget…"           |
| Server-only actions           | `requireSystem(c)`; system tokens from `asSystem()` in `peers.ts`           | `server.test.ts` › "system is reserved…"                       |
| Presence (who is here now)    | `c.vars.viewers`, `watch`, `presence` event, `onDisconnect` in `project.ts` | `server.test.ts`, `data.spec.ts`                               |
| Delete an entity              | `deleteProject` → outbox → `project.destroy()` → `c.destroy()`              | `server.test.ts` › "deleting a project…", `data.spec.ts`       |
| Stay awake between visits     | `ENTITY_OPTIONS` (`sleepTimeout: 5 min`) in `access.ts`                     | Configuration only                                             |

Rules:

- Never trust a raw id or connection state. Read the caller with `caller(c)` or `writer(c)` in every action.
- Never refuse in the organization's `canSubscribe`: a refused subscription closes the socket and the client reconnects in a loop.
- Never close a socket with an `auth.*` reason. The client reads those as its own gateway credentials and stops reconnecting.
- Presence belongs in `c.vars`. It describes open sockets, so it should vanish with them.

## The browser

| Need                                      | Code                                                                                             | Proof                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| One live entity: socket, snapshot, errors | `EntityViewModel` in `apps/web/src/lib/data/entity-view-model.svelte.ts`                         | `data.spec.ts`                                |
| Out-of-order replies and events           | `apply()` keeps the highest `revision`                                                           | `data.spec.ts`                                |
| Optimistic toggles                        | `#intended` in `ProjectViewModel`                                                                | `data.spec.ts`                                |
| Extra events (comments, presence)         | Override `listen(actor)`                                                                         | `data.spec.ts` › "comments, …"                |
| Paged threads that catch up on reconnect  | `ProjectViewModel` threads, `#loadNewest`                                                        | `data.spec.ts` › "comments, …"                |
| "Show older" activity                     | `activity`, `hasOlderActivity`, `showOlderActivity` on `EntityViewModel`                         | `store.test.ts`                               |
| Never create actors from the browser      | `noCreate` by default; only the user actor and a new organization pass `create`                  | `data.spec.ts` › "a guessed organization id…" |
| A one-shot call without a socket          | `once()` on `EntityViewModel`; `getRivetClient()` for `fetch`                                    | `data.spec.ts`                                |
| Dependencies read once, during setup      | `entityDeps()` in a component; pass `deps` to every view-model constructor                       | `svelte-check`                                |
| One socket per organization, kept warm    | `OrganizationCache` (`hold`, `warm`, 60 s grace) + `routes/data/orgs/[orgId]/+layout.svelte`     | `data.spec.ts`                                |
| Open a page before the click lands        | `organizations.warm(orgId)` on `pointerenter` / `focus` in `DataShell.svelte`                    | `data.spec.ts`                                |
| Busy state that does not flicker          | `isBusy(label)` for logic, `looksBusy(label)` for display (300 ms lag)                           | `data.spec.ts`                                |
| A pending look for any boolean            | `lagging(() => flag)` in `apps/web/src/lib/lagging.svelte.ts`                                    | `actor-lab.spec.ts`                           |
| Rapid clicks that never drop              | Queued `increment` / `incrementViaHttp` in `counter-view-model.svelte.ts`                        | `actor-lab.spec.ts`                           |
| Loading that does not move the page       | `Skeleton.svelte` sized like the content; fixed toolbar rows; known header fields from the index | `data.spec.ts`                                |
| Restore sign-in without a sign-in flash   | `preloadPrincipal(fetch)` in `routes/data/+layout.ts`                                            | `data.spec.ts`                                |

## Not included

These come up in real apps, but this repository does not show them yet:

- **Uploads and large files.** The export stores a small file in SQLite. For user uploads or large files, store objects in S3 with presigned URLs and keep only metadata in the actor.
- **An ORM.** Queries are plain SQL through `c.db.execute`. RivetKit also supports Drizzle; this repository does not use it.
- **Raw WebSockets.** Everything uses actions and events. `onWebSocket` is available for custom protocols.
- **Deleting an organization or an account.** Project deletion shows the pattern: remove the index entry and enqueue the destroy in one transaction.
- **Search across actors.** Each actor answers for itself. Cross-actor search needs an index actor or an external search service.
