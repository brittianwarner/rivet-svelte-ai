# Deploying the starter

Deploy the web app and API/actor runner as separate Node services, and connect the runner to your Rivet deployment. The repository includes runnable production commands; it does not provision infrastructure or publish a deployment.

## Build and run

```bash
bun install --frozen-lockfile
bun run validate

# API service (from repository root)
bun run --filter @example/api start

# Web service (a separate process, from repository root)
bun run --filter @example/web start
```

The API runs native TypeScript on Node 26; SvelteKit builds to `apps/web/build`. Install from the workspace root and keep the workspace packages available. The API does not require an application bundling step.

For a container, set `API_HOST=0.0.0.0` and the API port from your host. For the web service, set `HOST=0.0.0.0` and its `PORT`. Configure `paths: { origin: "https://app.example.com" }` inside `sveltekit(...)` in `apps/web/vite.config.ts` before building. SvelteKit 3 replaces adapter-node's old `ORIGIN` environment variable with this configuration. Set `API_ORIGIN` to the API's private HTTP URL. The production web server does not read root `.env` automatically.

## Connect a remote engine

Configure these only on the API service:

- `RIVET_ENDPOINT`: your engine endpoint.
- `RIVET_TOKEN` and `RIVET_NAMESPACE`: credentials and namespace supplied by Rivet.
- `RIVET_NODE_VERSION`: a monotonically increasing integer release number; follow your provider's version/upgrade configuration.
- `RIVET_PUBLIC_ENDPOINT`: the browser-safe public endpoint supplied by Rivet. Include only public client access material if required by your deployment, never the management secret.
- `WEB_ORIGINS`: comma-separated exact public web origins, such as `https://app.example.com`.
- Optional model credentials and model IDs.

With `RIVET_ENDPOINT` set, the registry does not start a local engine. Follow the current [Rivet deployment documentation](https://rivet.dev/docs/) for the selected host and configure its runner pool. Use HTTPS/WSS on public endpoints. Do not rely on ephemeral container disks for local-engine production persistence.

Rivet 3.0's [release announcement](https://rivet.dev/changelog/2026-10-26-introducing-rivet-3-0-preview/) notes that multi-region, serverless, and ACL support are still forthcoming in 3.0. Check current feature availability before choosing a deployment architecture. This template uses a long-running runner.

## Turn the demo into an application

The template intentionally does not choose an identity provider. Before public use with private data or model spending:

1. Authenticate users through your application and verify that identity on the actor connection.
2. Authorize the requested actor key against the verified user/organization. Opaque keys alone are not authorization.
3. Protect the HTTP counter route as well as direct actor actions. CORS is not an authentication layer.
4. Replace the public `ACTOR_TOKEN` demo parameter. It is returned by `/client-config` and cannot protect data from a visitor.
5. Add per-user/organization rate limits, actor-creation limits, AI budgets, retention, and actor cleanup. One active request per conversation is not an account-wide spending limit.
6. Add structured telemetry and redact provider credentials and sensitive prompts.

## Verify a release

`/health` proves the API process is listening. `/ready` only reports provider selection. Neither proves the actor runner or persistent storage is healthy.

Verify a typed actor action and event, a second browser, reconnect, restart persistence, denied unauthorized access, and an actual model turn in the deployed environment. For crash-resumable AI work, add workflow recovery tests. Test expected concurrency separately. Deploy reviewed changes through your normal release pipeline; there is no deployment automation in this starter.

## Local restart acceptance

`bun run test:restart` creates a temporary standalone engine and checks that the counter and completed chat transcript survive stopping and restarting the API/actor runner. The engine stays running during this acceptance test. Test storage is isolated from the developer's engine and removed afterward.

Full local engine recovery remains unqualified on RivetKit/Engine 3.0.1: an isolated test that also restarted the engine observed `depot/routing_unavailable`, `depot/command_capacity`, and actor readiness timeouts on subsequent reads. This does not establish data loss or successful recovery. To reproduce that investigation separately, run `FULL_ENGINE_RESTART=1 bun run test:restart`. Qualify engine restart recovery on the engine version and deployment you intend to operate before depending on it.

See the [local engine recovery report](local-engine-recovery.md) for reproduction steps, settings, and observed errors.
