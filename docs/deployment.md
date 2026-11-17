# Deploying

One image, one port, one bucket. The root [`Dockerfile`](../Dockerfile) builds a container that runs the Rivet engine node, the actor runner, the Elysia API and the SvelteKit web app as one Bun process tree on port 8080. The only external dependency is an S3-compatible bucket.

```
                 ┌──────────────── one container (ROLE=all) ─────────────────┐
browser ──https──▶ :8080  Bun.serve                                          │
                 │   /rivet/*  → gateway relay → engine Guard 127.0.0.1:6420 │
                 │   /api/*    → Elysia                                      │
                 │   else      → SvelteKit (Bun adapter)                     │
                 │                                                           │
                 │   rivet-engine ◀──api_peer :6421 (private)──▶ other nodes │
                 └───────────────────────────┬───────────────────────────────┘
                                             │ https
                                        S3 bucket (cluster config, cold tier)
```

Browsers only ever talk to this origin. `/rivet/*` is a relay, not an open engine: it accepts gateway and actor traffic from allowed origins and returns 404 for engine administration (`/rivet/namespaces`, `/rivet/actors`, `/rivet/pools/…`, `/rivet/auth/tokens`, `/rivet/envoys/connect`). The engine admin token never leaves the server.

## Services and roles

The workspace is organized by service. Each is a package; `apps/server` composes them into one Bun process:

| Service | Package(s)                                            | Does                                                           |
| ------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| engine  | `@example/rivet-engine`                               | Runs a Rivet engine node from `S3_*`; bootstraps the namespace |
| actors  | `@example/actors`, `@example/entities`                | The runner: registers with the engine and executes actors      |
| front   | `@example/api`, `@example/rivet-edge`, `@example/web` | The public port: `/api`, the `/rivet` relay, SvelteKit         |

`ROLE` picks which services a container runs. The image is the same for every role.

| `ROLE`          | engine | actors | front | Needs                                            |
| --------------- | :----: | :----: | :---: | ------------------------------------------------ |
| `all` (default) |   ✓    |   ✓    |   ✓   | `S3_*`, `RIVET_TOKEN`, `ENTITY_SECRET`           |
| `app`           |        |   ✓    |   ✓   | `RIVET_ENDPOINT`, `RIVET_TOKEN`, `ENTITY_SECRET` |
| `engine`        |   ✓    |        |       | `S3_*`, `RIVET_TOKEN`                            |
| `runner`        |        |   ✓    |       | `RIVET_ENDPOINT`, `RIVET_TOKEN`, `ENTITY_SECRET` |
| `front`         |        |        |   ✓   | `RIVET_ENDPOINT`, `RIVET_TOKEN`, `ENTITY_SECRET` |

Start with `all`. Split when one part needs to scale or deploy on its own:

- **Engine nodes** hold state. They should change only when Rivet does.
- **Runners** execute actors. Scale them with actor count and CPU.
- **Front** replicas are stateless: HTTP, SSR and socket relay. Scale them with request load.

A `runner` answers only `/api/health` and `/api/health/actors` on `PORT`; give it no domain. A `front` reports ready once the engine answers, since it hosts no actors. Runners and fronts verify each other's principal tokens, so they share `ENTITY_SECRET`. `apps/server/tests/tiers.test.ts` runs engine, runner and front as separate processes and checks that the front serves actors it does not host and that a token the front signs is accepted by the runner.

`ROLE=all` without `S3_BUCKET` is local development: RivetKit spawns a single throwaway engine. With `S3_BUCKET`, every replica is a cluster node. Replicas find each other through heartbeats in the bucket, then replicate over the private network on `api_peer` (6421). Each write lands on two of three nodes' disks, then tiers to the bucket after about 15 s.

## Configuration

| Variable                                   | Purpose                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `PORT`, `HOST`                             | `8080` and `::` in the image                                                        |
| `PUBLIC_ORIGIN`                            | The site's public origin. The edge and the API accept browsers from it              |
| `WEB_ORIGIN`                               | Build arg: the same origin, for absolute SSR URLs                                   |
| `WEB_ORIGINS`                              | Extra allowed origins (local dev)                                                   |
| `RIVET_TOKEN`                              | Engine admin token. Server-side only; identical on every node of one cluster        |
| `RIVET_NAMESPACE`                          | Namespace created on first boot if missing (`default`)                              |
| `RIVET_ENDPOINT`                           | Roles without an engine: the engine service's private URL                           |
| `RIVET_NODE_VERSION`                       | Optional. Overrides the build-time release version; see [Rollbacks](#rollbacks)     |
| `S3_BUCKET`, `S3_ENDPOINT`                 | Bucket and endpoint. **https only**                                                 |
| `S3_REGION`                                | `auto` by default                                                                   |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Bucket credentials                                                                  |
| `S3_PREFIX`                                | Key prefix for this cluster (`rivet/`). Two clusters must never share one           |
| `S3_VIRTUAL_HOSTED`                        | `true` (default) addresses `<bucket>.<endpoint host>`; `false` uses path style      |
| `ENTITY_SECRET`                            | Derives the user and system token keys. Identical on every replica                  |
| `ENTITY_EXPORT_TTL_SECONDS`                | Optional, default `3600`. How long a CSV export is kept before its actor is deleted |
| `RIVET__*`                                 | Any engine setting. Operator values override the image's defaults                   |

The engine's S3 client does not speak plain http. Given an `http://` endpoint it sends nothing and boot times out with "config operation timed out", so the server refuses an `http://` `S3_ENDPOINT` at startup. For a local MinIO, put a TLS proxy in front and trust its CA with `SSL_CERT_FILE`, as [`deploy/compose.replicas.yml`](../deploy/compose.replicas.yml) does.

The advertise address for `api_peer` is detected at boot: a unique-local IPv6 on the container's interfaces (Railway's private network), or a private IPv4 that `RAILWAY_PRIVATE_DOMAIN` resolves to. If none fits, the log lists the interfaces it saw. Elsewhere, set `RIVET__API_PEER__ADVERTISE_ADDRESS=<private ip>:6421` per replica.

## Health

| Path                 | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `/api/health`        | The process is listening                                         |
| `/api/health/actors` | This replica's runner is registered and serving. The deploy gate |

On SIGTERM the server flips readiness to 503, stops accepting HTTP, lets actors sleep and the runner deregister, then stops the engine node, which hands off its partitions before exiting. Bun is PID 1; give it the platform's full drain window.

## Deploys rotate the storage nodes

With `ROLE=all`, every deploy replaces every engine node. That is safe only when the new nodes join before the old ones leave, and the old ones get time to hand off.

- **Overlap ≥ 120 s.** New replicas start on empty disks beside the old ones and take replicas of the partitions.
- **Drain ≥ 660 s.** The engine's partition handoff budget is 590 s.

Both are set in [`.railway/railway.ts`](../.railway/railway.ts). Replacing nodes faster than that lost quorum permanently in rehearsal (`depot_overloaded`, "volume client made no quorum progress"). It did not recover without wiping the cluster. Do not shorten these windows, and do not restart all replicas at once.

### Rehearsed locally

[`deploy/rehearse-deploy.sh`](../deploy/rehearse-deploy.sh) runs Railway's sequence against six replicas in Docker Compose (MinIO behind a TLS proxy, a Caddy edge on :8080): three old replicas serve, three new ones start on fresh disks, they overlap for 120 s while a counter is incremented every 2 s, then the old ones get SIGTERM with a 660 s grace.

Results on Engine 3.1.1:

- A fresh 3-node cluster formed by itself in about 80 s.
- Two full rotations of all three storage nodes (app1-3 → app4-6, then back onto fresh disks): 0 failed increments, exact final counts (109 and 103), old replicas exited 0, every acceptance check passed.
- A stop/start of each replica in turn: 0 failed requests.
- The same image split into tiers (3 `engine`, 2 `runner`, 2 `front`; compose profile `tiers` on :8081): the cluster formed in about 80 s and every acceptance check passed through the front tier.

```sh
docker build --platform linux/amd64 -t rivet-svelte-ai:local .
./deploy/rehearse-deploy.sh                                  # app1-3 → app4-6
OLD="app4 app5 app6" NEW="app1 app2 app3" ./deploy/rehearse-deploy.sh
# The tier split:
docker compose -f deploy/compose.replicas.yml --profile tiers up -d \
  engine1 engine2 engine3 runner1 runner2 front1 front2 edge-tiers
bun run test:deployment http://localhost:8081
docker compose -f deploy/compose.replicas.yml --profile next --profile tiers down -v
```

The compose file holds local placeholder credentials only.

### Topologies

`.railway/railway.ts` has a `TOPOLOGY` switch. The public service is always `app`, so its domain survives a switch.

- **`all`** (default): one service, three replicas. Simplest to run. Every push rotates the storage nodes, so each deploy takes overlap + drain (about 13 minutes) and carries the rotation risk above.
- **`split`**: the same image as two services. `engine` (`ROLE=engine`, 3 replicas) holds state and is redeployed only to change Rivet. `app` (`ROLE=app`) scales freely and redeploys in about a minute without touching storage. Prefer it once you deploy more than a few times a day.
- **`tiers`**: three services. `engine` as in `split`, `runner` (`ROLE=runner`) for actors, and `app` (`ROLE=front`) for web, `/api` and `/rivet`. Use it when actor load and request load grow at different rates.

### Rollbacks

Each image records a release version at build time (`.release-version`, a Unix timestamp). The engine drains runners onto the highest version, so a newer build takes over during a deploy. To roll back to an older image, set `RIVET_NODE_VERSION` to an integer higher than the current release. Never reuse a version for different code.

## Risks you accept

- **Recent writes can be lost if every node dies at once.** Disks are ephemeral. A write is on two nodes' disks first and reaches the bucket about 15 s later. Losing all replicas together inside that window loses those writes. One node at a time is fine.
- **The bucket is the backup.** Railway buckets have no versioning. Deleting the bucket or the prefix deletes the cluster. Add your own copy if the data matters.
- **Engine upgrades need a full stop the first time.** Rolling across engine versions is not qualified here. Stop all replicas, deploy, start. Bump the engine image digest and `rivetkit` in one commit.
- **`api_peer` (6421) is plaintext.** Keep it on the private network. Never give it, Guard (6420) or metrics a public domain.
- **One cluster per prefix.** Two clusters on one `S3_PREFIX` corrupt each other.

## Railway

[`.railway/railway.ts`](../.railway/railway.ts) is the source of truth: one bucket, one `app` service (or `engine` + `app`), generated `RIVET_TOKEN` and `ENTITY_SECRET`, health check `/api/health/actors`, overlap 120 s, drain 660 s.

```sh
railway login
railway link --project YOUR_PROJECT_ID --environment production
railway status --json                # confirm project AND environment
bun run railway:plan                 # read-only diff
railway config plan --out /tmp/railway-plan.json
# Read every Destroy line, then (a human):
railway config apply --plan /tmp/railway-plan.json
```

**Migrating an existing project from the old three-service layout:** the plan destroys the `rivet`, `api` and `web` services and the `rivet-log` volume, because the file no longer declares them. Actor state from the old engine does not carry over: the new cluster uses the `rivet-cluster/` prefix. Export anything you need first.

Forks: change `repository` and `domain` at the top of the file. Custom domains attach once in the dashboard, then move into the file.

Diagnose with `railway logs --service app --lines 100`. Logs can contain application data; never paste credentials.

## Verify a deployment

```sh
bun run test:deployment https://YOUR_DOMAIN
```

It checks the client config points at `<origin>/rivet`, a counter action and its WebSocket event, the HTTP API on the same actor, six fresh clients agreeing on one count (replica consistency), and that engine admin routes return 404. It never calls an AI provider. Save the printed key to check persistence after a deploy:

```sh
SMOKE_ACTOR_KEY=acceptance-... SMOKE_EXPECT_COUNT=9 bun run test:deployment https://YOUR_DOMAIN
```

Locally, `bun run test:integration` runs the same server against a real isolated engine: the edge, counter, organization/user entities, refused unsigned principals, token expiry and reconnect, server-only actions, write limits, and state across a server restart.

## Before real users

The starter does not choose an identity provider. Before private data or model spending:

1. Replace the demo sign-in. `packages/api/src/entity-routes.ts` treats picking a persona as signing in. Swap that handler for your identity provider's callback: authenticate the person, then return `{ principal, token: signPrincipal(principal, ttl), expiresIn: ttl }`. The actors, the browser view model and token refresh stay unchanged. To accept your provider's JWTs directly, replace `verifyPrincipal` in `packages/entities/src/principal.ts`; it must keep returning `{ principal, expiresAt }` and keep `system` reserved.
2. Authorize every actor key against the verified principal, on both actions and HTTP routes. Keys and CORS are not authorization. The entity actors show the pattern; see [access control](architecture.md#access-control).
3. Replace the public `ACTOR_TOKEN` demo parameter.
4. Review the built-in limits: 60 sign-ins per minute per client address, and 30 writes then 5 per second per person per actor. Both are in memory per replica. Add per-account sign-in limits, AI budgets, retention, and actor cleanup.
5. Add telemetry that redacts credentials and prompts.

The sign-in limit keys on the last `X-Forwarded-For` entry, which the single proxy hop in front of the app (Railway's edge) appends, and falls back to the socket address. Behind more proxies, change `deriveTrustedClientIp` in `packages/rivet-edge` to match.

Tokens cannot be revoked before they expire; removal from an organization or project takes effect immediately, because every call checks the current role. Keep token lifetimes short (the demo uses one hour), or add a revocation list if you need instant sign-out.
