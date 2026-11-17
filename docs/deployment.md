# Deploying

One image, three services, two buckets. The root [`Dockerfile`](../Dockerfile) builds one container; `ROLE` decides what it runs. Production runs it three ways:

```
                ┌ app (ROLE=web) ×2 ┐  private  ┌ api (ROLE=api) ×2 ─┐  private  ┌ engine ×3 ─────────┐
browser ─https─▶│ :8080 SvelteKit   │──http────▶│ :8080 /api  Elysia │──http────▶│ Guard :6420        │
                │ /api, /rivet ──────┼─forward──▶│ /rivet relay       │           │ api_peer :6421 ◀──▶│ other nodes
                │ no secrets         │           │ actors (runner)    │           └─────────┬──────────┘
                └────────────────────┘           └─────────┬──────────┘                     │ https
                                                           │ https                 bucket rivet-cluster
                                                     bucket files                  (cluster config, cold tier)
                                                     (exports, app files)
```

- **app** (`ROLE=web`, public): pages, and the browser's only origin. It forwards `/api` and `/rivet` to `api` unchanged, sockets included. It holds no secrets and no bucket. Scale it with page load.
- **api** (`ROLE=api`, private): actors, the HTTP API and the `/rivet` relay. It holds the engine credentials and the principal-token secret, and keeps app files in its own bucket. Scale it with actor load.
- **engine** (`ROLE=engine`, private, 3 replicas): the Rivet cluster. State lives on the nodes' disks and tiers to its own bucket. Redeploy it only to change Rivet.

Pages and actors no longer share a thread: an AI reply streaming or a CSV export on an api replica does not slow page loads, and a page-load spike does not slow actors. Each service deploys on its own schedule; pushing app or api code rotates no storage node.

Browsers only ever talk to `app`. `/rivet/*` is a relay, not an open engine: the api accepts gateway and actor traffic from allowed origins and returns 404 for engine administration (`/rivet/namespaces`, `/rivet/actors`, `/rivet/pools/…`, `/rivet/auth/tokens`, `/rivet/envoys/connect`). The engine admin token never leaves the api.

## Services and roles

The workspace is organized by service. Each is a package; `apps/server` composes them:

| Service | Package(s)                                               | Does                                                             |
| ------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| engine  | `@example/rivet-engine`                                  | Runs a Rivet engine node; bootstraps the namespace               |
| actors  | `@example/actors`, `@example/entities`, `@example/files` | The runner: registers with the engine and executes actors        |
| api     | `@example/api`, `@example/rivet-edge`                    | `/api` and the `/rivet` relay                                    |
| web     | `@example/web`, `@example/rivet-edge` (forwarder)        | SvelteKit; with no api in the process, forwards `/api`, `/rivet` |

| `ROLE`          | engine | actors | api | web | Needs                                                       |
| --------------- | :----: | :----: | :-: | :-: | ----------------------------------------------------------- |
| `all` (default) |   ✓    |   ✓    |  ✓  |  ✓  | `S3_*`, `FILES_*`, `RIVET_TOKEN`, `ENTITY_SECRET`           |
| `app`           |        |   ✓    |  ✓  |  ✓  | `RIVET_ENDPOINT`, `RIVET_TOKEN`, `ENTITY_SECRET`, `FILES_*` |
| `engine`        |   ✓    |        |     |     | `S3_*`, `RIVET_TOKEN`                                       |
| `api`           |        |   ✓    |  ✓  |     | `RIVET_ENDPOINT`, `RIVET_TOKEN`, `ENTITY_SECRET`, `FILES_*` |
| `web`           |        |        |     |  ✓  | `API_URL`                                                   |

`web` answers `/healthz` itself and never waits on the api for it, so a slow api does not take pages down. When the api is unreachable, `/api` and `/rivet` return 502 `{"error":"api_unreachable"}`. `API_URL` is a private name that resolves to every api replica (Railway's `api.railway.internal`); web re-resolves it every 5 s and spreads requests and sockets across the addresses. A request without a body that cannot connect (a replica draining mid-deploy) is retried once on the next address.

Web replaces `X-Forwarded-For` with the one client address it trusts (the last entry, which Railway's edge appends) and sets `X-Forwarded-Host` and `-Proto`, so the api sees the browser, never a value the browser chose. `apps/server/tests/split.test.ts` runs engine, api and web as separate processes and checks health, sockets, HTTP, principal tokens, a workflow and a file download through web.

`ROLE=all` with `S3_BUCKET` makes every replica a cluster node plus the app. Without it (local development), it starts one local engine with its data in `.rivet/engine`.

## App files

Actors keep small records in their own SQLite and the bytes in the api's bucket (`FILES_*`), separate from the engine's. A CSV export is a row in its actor and an object at `exports/<org>/<project>/<export>.csv`; the actor streams it on download and deletes it when the export expires. Keys are paths of `[A-Za-z0-9._-]` segments, nothing else.

| Where                          | Store                                                          |
| ------------------------------ | -------------------------------------------------------------- |
| `FILES_BUCKET` set             | That bucket                                                    |
| `FILES_DIR` set                | That directory                                                 |
| neither, development           | `<repo>/.rivet/files`                                          |
| neither, `NODE_ENV=production` | Refuses to start: a container's disk does not survive a deploy |

## Configuration

| Variable                                               | Purpose                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `ROLE`                                                 | `all`, `app`, `engine`, `api` or `web`                                                |
| `PORT`, `HOST`                                         | `8080` and `::` in the image                                                          |
| `PUBLIC_ORIGIN`                                        | The site's public origin. The api accepts browsers from it                            |
| `WEB_ORIGIN`                                           | Build arg: the same origin, for absolute SSR URLs                                     |
| `WEB_ORIGINS`                                          | Extra allowed origins (local dev)                                                     |
| `API_URL`                                              | `ROLE=web`: the api service's private origin, e.g. `http://api.railway.internal:8080` |
| `RIVET_TOKEN`                                          | Engine admin token. Server-side only; identical on every node of one cluster          |
| `RIVET_NAMESPACE`                                      | Namespace created on first boot if missing (`default`)                                |
| `RIVET_ENDPOINT`                                       | Roles without an engine: the engine service's private URL                             |
| `RIVET_NODE_VERSION`                                   | Optional. Overrides the build-time release version; see [Rollbacks](#rollbacks)       |
| `S3_BUCKET`, `S3_ENDPOINT`                             | The engine's bucket and endpoint. **https only**                                      |
| `S3_REGION`                                            | `auto` by default                                                                     |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`             | Engine bucket credentials                                                             |
| `S3_PREFIX`                                            | Key prefix for this cluster (`rivet/`). Two clusters must never share one             |
| `S3_VIRTUAL_HOSTED`                                    | `true` (default) addresses `<bucket>.<endpoint host>`; `false` uses path style        |
| `FILES_BUCKET`, `FILES_ENDPOINT`                       | The api's bucket for app files                                                        |
| `FILES_ACCESS_KEY_ID`, `FILES_SECRET_ACCESS_KEY`       | Its credentials                                                                       |
| `FILES_REGION`, `FILES_PREFIX`, `FILES_VIRTUAL_HOSTED` | `auto`, none, `true` by default                                                       |
| `FILES_DIR`                                            | A directory instead of a bucket (one machine only)                                    |
| `ENTITY_SECRET`                                        | Derives the user and system token keys. Identical on every api replica                |
| `ENTITY_EXPORT_TTL_SECONDS`                            | Optional, default `3600`. How long a CSV export is kept before its actor is deleted   |
| `RIVET__*`                                             | Any engine setting. Operator values override the image's defaults                     |

The engine's S3 client does not speak plain http. Given an `http://` endpoint it sends nothing and boot times out with "config operation timed out", so the server refuses an `http://` `S3_ENDPOINT` at startup. For a local MinIO, put a TLS proxy in front and trust its CA with `SSL_CERT_FILE`, as [`deploy/compose.replicas.yml`](../deploy/compose.replicas.yml) does.

The advertise address for `api_peer` is detected at boot: a unique-local IPv6 on the container's interfaces (Railway's private network), or a private IPv4 that `RAILWAY_PRIVATE_DOMAIN` resolves to. If none fits, the log lists the interfaces it saw. Elsewhere, set `RIVET__API_PEER__ADVERTISE_ADDRESS=<private ip>:6421` per replica.

## Health

| Path                 | Service       | Meaning                                                          |
| -------------------- | ------------- | ---------------------------------------------------------------- |
| `/healthz`           | web           | This replica is listening and not stopping. The deploy gate      |
| `/api/health`        | api, app, all | The process is listening                                         |
| `/api/health/actors` | api, app, all | This replica's runner is registered and serving. The deploy gate |
| `/health` on 6420    | engine        | Guard is up. The deploy gate                                     |

On SIGTERM a server flips readiness to 503, lets in-flight requests finish (10 s), closes the sockets that remain (browsers reconnect through another replica), lets actors sleep and the runner deregister, then stops the engine node if it runs one, which hands off its partitions before exiting. Bun is PID 1; give it the platform's full drain window.

## Deploys rotate the storage nodes

A deploy of `engine` (or of any `ROLE=all` service) replaces every engine node. That is safe only when the new nodes join before the old ones leave, and the old ones get time to hand off.

- **Overlap ≥ 120 s.** New replicas start on empty disks beside the old ones and take replicas of the partitions.
- **Drain ≥ 660 s.** The engine's partition handoff budget is 590 s.

Both are set in [`.railway/railway.ts`](../.railway/railway.ts). Replacing nodes faster than that lost quorum permanently in rehearsal (`depot_overloaded`, "volume client made no quorum progress"). It did not recover without wiping the cluster. Do not shorten these windows, and do not restart all replicas at once. `api` and `app` are stateless: 30 s overlap, 120 s drain.

### Rehearsed locally

[`deploy/compose.replicas.yml`](../deploy/compose.replicas.yml) runs the production layout in Docker Compose: 3 engine nodes, 2 api, 2 web, MinIO behind a TLS proxy holding both buckets, a Caddy edge on :8080, and Docker's DNS resolving `engine` and `api` to every replica as Railway's private network does. [`deploy/rehearse-deploy.sh`](../deploy/rehearse-deploy.sh) runs Railway's sequence on it: the current release serves, the next one (engine4-6, api3-4, web3-4) starts on fresh disks, they overlap for 120 s while a counter is incremented every 2 s through the edge, then the old release gets SIGTERM.

Results on Engine 3.1.1:

- A cold stack (3 engine nodes, 2 api, 2 web) was healthy in 89 s.
- A full release of all three services at once (engine1-3 → engine4-6, api1-2 → api3-4, web1-2 → web3-4): 0 failed increments, the exact final count (99), every acceptance check passed.
- Earlier, on `ROLE=all`: two full rotations of all three storage nodes with 0 failed increments and exact counts, and a stop/start of each replica in turn with 0 failed requests.

```sh
docker compose -f deploy/compose.replicas.yml up --build -d --wait
bun run test:deployment http://localhost:8080
./deploy/rehearse-deploy.sh
docker compose -f deploy/compose.replicas.yml --profile next --profile all down -v
# On an arm64 machine, build natively (much faster than emulating amd64):
#   APP_IMAGE=rivet-svelte-ai:arm64 APP_PLATFORM=linux/arm64 docker compose ...
```

The compose file holds local placeholder credentials only.

### Load, same 6 CPUs

3,000 sockets through the edge, one counter action every 2 s each (about 1,500 per second), on the local stack with a fixed CPU budget:

| Layout                                            | Action p50 | Action p95 (typical 5 s window) | Rejected            | Page p50 under load |
| ------------------------------------------------- | ---------: | ------------------------------: | ------------------- | ------------------: |
| `ROLE=all`, 3 replicas × 2 CPU                    |      46 ms |                         ~125 ms | 11                  |              0.7 ms |
| split, engine 3 × 1, api 2 × 1, web 2 × 0.5       |      43 ms |                         ~110 ms | 0.4% (2.5 s stalls) |              0.8 ms |
| split, engine 3 × 1.4, api 2 × 0.75, web 2 × 0.15 |      32 ms |                       93–165 ms | 51 of ~81,000       |              0.6 ms |

The engine does most of the work: the busiest node ran at 85–95% of its CPU and about 2 GB of memory, the api about 0.6 of a core each, web under a tenth of a core. Give the engine service the most CPU; web needs almost none.

### Topologies

`.railway/railway.ts` has a `TOPOLOGY` switch. The public service is always `app`, so its domain survives a switch.

- **`split`** (default): the three services above.
- **`all`**: one service, three replicas, every replica an engine node plus everything else. Simplest. Every push rotates the storage nodes (overlap + drain, about 13 minutes) and carries the rotation risk above, and pages share a thread with actors.

The two use different engine prefixes (`engine/` and `rivet-cluster/`), so a switch starts a fresh cluster and leaves the other prefix untouched; switching back finds it again.

### Rollbacks

Each image records a release version at build time (`.release-version`, a Unix timestamp). The engine drains runners onto the highest version, so a newer build takes over during a deploy. To roll back to an older image, set `RIVET_NODE_VERSION` to an integer higher than the current release. Never reuse a version for different code.

## Risks you accept

- **Recent writes can be lost if every node dies at once.** Disks are ephemeral. A write is on two nodes' disks first and reaches the bucket about 15 s later. Losing all replicas together inside that window loses those writes. One node at a time is fine.
- **The bucket is the backup.** Railway buckets have no versioning. Deleting the bucket or the prefix deletes the cluster. Add your own copy if the data matters.
- **Engine upgrades need a full stop the first time.** Rolling across engine versions is not qualified here. Stop all replicas, deploy, start. Bump the engine image digest and `rivetkit` in one commit.
- **`api_peer` (6421) is plaintext.** Keep it on the private network. Never give it, Guard (6420) or metrics a public domain.
- **One cluster per prefix.** Two clusters on one `S3_PREFIX` corrupt each other.
- **The files bucket is the only copy of app files.** Exports expire on their own; anything you add that must outlive a mistake needs its own backup.
- **api and web talk in plaintext http** over the private network. Keep `api` without a public domain; it trusts the `X-Forwarded-*` headers web sets.

## Railway

[`.railway/railway.ts`](../.railway/railway.ts) is the source of truth: two buckets (`rivet-cluster` for the engine, `files` for the api), three services (`app`, `api`, `engine`), generated `RIVET_TOKEN` and `ENTITY_SECRET`, health checks, and the rollout windows above.

```sh
railway login
railway link --project YOUR_PROJECT_ID --environment production
railway status --json                # confirm project AND environment
bun run railway:plan                 # read-only diff
railway config plan --out /tmp/railway-plan.json
# Read every Destroy line, then (a human):
railway config apply --plan /tmp/railway-plan.json
```

**Migrating from `TOPOLOGY = "all"`:** the plan creates `engine`, `api` and the `files` bucket, turns `app` into `ROLE=web`, and deletes the engine and token variables `app` no longer needs. Actor state does not carry over: the new cluster uses the `engine/` prefix, and the old `rivet-cluster/` prefix stays in the bucket. Export anything you need first.

Forks: change `repository` and `domain` at the top of the file. Custom domains attach once in the dashboard, then move into the file.

Diagnose with `railway logs --service api --lines 100` (or `app`, `engine`). Logs can contain application data; never paste credentials.

## Verify a deployment

```sh
bun run test:deployment https://YOUR_DOMAIN
```

It checks the client config points at `<origin>/rivet`, a counter action and its WebSocket event, the HTTP API on the same actor, six fresh clients agreeing on one count (replica consistency), and that engine admin routes return 404. It never calls an AI provider. Save the printed key to check persistence after a deploy:

```sh
SMOKE_ACTOR_KEY=acceptance-... SMOKE_EXPECT_COUNT=9 bun run test:deployment https://YOUR_DOMAIN
```

Locally, `bun run test:integration` runs the same server against a real isolated engine, both as one process and as api behind web: the edge, counter, organization/user entities, refused unsigned principals, token expiry and reconnect, server-only actions, write limits, and state across a server restart.

## Before real users

The starter does not choose an identity provider. Before private data or model spending:

1. Replace the demo sign-in. `packages/api/src/entity-routes.ts` treats picking a persona as signing in. Swap that handler for your identity provider's callback: authenticate the person, then return `{ principal, token: signPrincipal(principal, ttl), expiresIn: ttl }`. The actors, the browser view model and token refresh stay unchanged. To accept your provider's JWTs directly, replace `verifyPrincipal` in `packages/entities/src/principal.ts`; it must keep returning `{ principal, expiresAt }` and keep `system` reserved.
2. Authorize every actor key against the verified principal, on both actions and HTTP routes. Keys and CORS are not authorization. The entity actors show the pattern; see [access control](architecture.md#access-control).
3. Replace the public `ACTOR_TOKEN` demo parameter.
4. Review the built-in limits: 60 sign-ins per minute per client address, and 30 writes then 5 per second per person per actor. Both are in memory per api replica. Add per-account sign-in limits, AI budgets, retention, and actor cleanup.
5. Add telemetry that redacts credentials and prompts.

The sign-in limit keys on the last `X-Forwarded-For` entry and falls back to the socket address. Railway's edge appends the browser's address; web keeps exactly that one entry when it forwards, so the api reads the same value either way. Behind more proxies, change `deriveTrustedClientIp` in `packages/rivet-edge` to match.

Tokens cannot be revoked before they expire; removal from an organization or project takes effect immediately, because every call checks the current role. Keep token lifetimes short (the demo uses one hour), or add a revocation list if you need instant sign-out.
