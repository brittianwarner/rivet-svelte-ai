# rivet + svelte

[Try the playground at svelteactors.dev](https://svelteactors.dev).

Build apps that stay in sync with **RivetKit 3.1.1**, **Bun + Elysia**, **Svelte 5**, and **SvelteKit 3**. Start with a working app: independent counter actors, live Svelte components, and a session that remembers what you create. Try the 3D playground, inspect the code, then make it yours.

This is a community-built starter with a workspace Svelte adapter. The learning page renders on the server; actor connections open in the browser. An optional streaming chat implementation is included in the repository.

- A local Rivet engine starts automatically. No Docker, account, or AI key needed for the counter.
- One Bun server serves the web app, `/api` and the `/rivet` actor edge on one port. In production the same container also runs the engine node; it needs only an S3 bucket.
- A Turborepo workspace: each service is a package, and `ROLE` splits the same image into engine, runner and front tiers when one needs to scale on its own.
- Actor actions and events stay typed from the API registry to Svelte.
- Each actor has its own SQLite database; each browser provider owns its client and cleans it up.
- A `/data` browser shows a full app: sign-in, organizations, roles, invitations, projects, tasks, comments, presence, CSV exports, deletion, and paged history.
- Small actors, shared contracts, and view models give new features a clear home.
- Type checks, unit tests, a production build, and real-browser acceptance tests are included.

## Start here

Install [Bun](https://bun.sh/) **1.4.4** or newer. Bun manages the workspace and runs everything; Node is not required.

```bash
git clone https://github.com/brittianwarner/rivet-svelte-ai.git
cd rivet-svelte-ai
bun install --frozen-lockfile
bun run dev
```

Open **http://127.0.0.1:5173**. Click **+ Increment**, then open a second tab. Your browser gets a session actor that remembers the counters you create. **Add actor** creates an independent counter in that session; another tab in the same browser restores the same registry. **+ Via HTTP** reaches the selected counter through the API. Use **Actor key → Connect** to attach a known counter to your session.

The first install/start needs internet access for dependencies and the native engine. The default ports are 5173 (Vite), 3001 (the Bun server: `/api` and `/rivet`; Vite proxies both) and 6440 (the local engine). The local Services/agentOS host is disabled because these examples do not use it.

## Your playground session

A real `session` actor holds the registry of counters for each visitor. The browser stores only a random session ID in local storage; actor keys and labels live in Rivet state. Reloading restores the registry and reconnects its counters. If storage is unavailable, the current page still works with a temporary session.

The session creates its starter counter and records every counter created or attached through the playground. Creation requests carry idempotency IDs so retries do not create duplicates. The playground limits each session to seven counters. **Disconnect actor** releases that browser connection while retaining the actor in the session; **Reconnect actor** opens it again. A reload reconnects all saved counters. The trash control in the canvas removes the selected actor from the session and closes its playground connections across tabs. It does not destroy the counter: **Undo** restores its key, label, and state. Removing every actor leaves an empty canvas after reload. The session keeps the latest 64 creation IDs to deduplicate recent retries. The connected count refers to counter sockets in this page; the session connection is shown separately.

Sessions group actors; each counter still owns its state and receives actions directly. These anonymous demo sessions are browser identities, not authenticated accounts or an authorization boundary. Clearing local storage starts a fresh session; the previous actors are not destroyed.

## Optional chat implementation

The homepage intentionally shows counter actors only. Chat is kept as reusable code: [ChatPanel.svelte](apps/web/src/lib/components/ChatPanel.svelte), [ChatViewModel](apps/web/src/lib/view-models/chat-view-model.svelte.ts), [provider setup](apps/web/src/lib/view-models/provider-view-model.svelte.ts), and the [chat actor](packages/actors/src/chat.ts).

To use it, render the panel below the existing `RivetProvider` and connect its view models during the browser lifecycle:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import ChatPanel from "#lib/components/ChatPanel.svelte";
  import { ChatViewModel, ProviderViewModel } from "#lib/view-models/index.js";

  const chat = new ChatViewModel();
  const provider = new ProviderViewModel();
  onMount(() => {
    const release = chat.connect();
    void provider.load();
    return () => {
      release();
      provider.dispose();
    };
  });
</script>

<ChatPanel {chat} {provider} />
```

Then configure the API's provider key. Without one, the chat actor is not hosted.

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY, then restart bun run dev.
```

A non-empty OpenRouter key takes precedence; otherwise the app uses Gemini. Defaults are `z-ai/glm-5.3-flash` and `gemini-3.8-flash`, respectively. Both are configurable. Provider keys stay in the API process. The browser only receives the provider name, model name, and public connection configuration.

Chat IDs live in the tab's session storage. Reloading restores recent messages; **New chat** starts another actor. Closing a tab does not cancel an active reply. **Stop** cancels the active generation.

This is a bounded conversation example: at most 40 recent messages / 64 KiB of serialized transcript, 20 prompt messages, 8,000 input/output characters per message, 2,000 model output tokens, a two-minute request timeout, one queued or active turn per actor, and 30 turns per conversation per hour (`CHAT_TURN_LIMIT`). The budget is per conversation; a real spending limit belongs at the edge or in a coordinating actor. Older messages are discarded. Stream updates are coalesced to roughly 10 per second plus a final update.

**Recovery semantics:** reconnecting reads an atomic history/status snapshot and applies events received during that read. The transcript persists in the actor's SQLite database, but an external model stream is not a durable workflow. A restart can interrupt a reply. The admitted prompt is stored until its turn starts, so a turn that was waiting when the actor slept runs on wake; a turn that was already streaming is marked interrupted. For resumable paid work, introduce a durable workflow, idempotent request IDs, and provider-specific retry handling; see [architecture](docs/architecture.md).

## Find your way around

```text
apps/
  server/                   # The one deployable: composes the packages by ROLE
    src/server.ts           # Boot, routing (/rivet, /api, web), drain
    tests/                  # Real-engine integration, split tiers, smoke, deployment
  web/                      # SvelteKit app; the server mounts its build
    src/lib/view-models/    # Reactive state, actions, and reconnect snapshots
    src/lib/components/     # Provider, connection loader, playground panels
packages/
  actors/                   # counter, session, chat actors + the registry
  entities/                 # User, organization, project, export actors; commit + outbox
  api/                      # Elysia routes as plugins (no env reads)
  rivet-engine/             # Engine node from S3_*, namespace bootstrap
  rivet-edge/               # The /rivet relay; engine admin denied
  config/                   # Environment, ROLE presets, logging
  wire/                     # Browser-safe contracts and limits
  rivetkit-svelte/          # Workspace Svelte adapter and its tests
  sveltekit-adapter-bun/    # SvelteKit adapter for Bun
Dockerfile                  # The single production image
deploy/                     # Local replica cluster + deploy rehearsal
```

`@rivetkit/svelte` in this repository is a **workspace package**, not a claim of official Rivet support or npm publication. Keep it with the app when copying this template. [Adapter API reference](packages/rivetkit-svelte/README.md).

## Build your first feature

1. Start with [the actor-to-Svelte tutorial](docs/first-actor.md), then find the pattern you need in [recipes](docs/recipes.md): SQLite and migrations, transactions, the outbox, workflows, files, access control, presence, deletion, and the tests that prove each one.
2. Put business rules in `packages/actors/src/your-feature.ts` and register the actor in `packages/actors/src/registry.ts`.
3. Use compound keys such as `[organizationId, documentId]`. Choose a key per independent unit of state; avoid a single global actor for all users.
4. Add shared DTOs to `packages/wire`. Import the API registry with `import type` so server code never enters the browser bundle.
5. Own connections in a component or view model, subscribe before loading snapshots, and release them when the component is removed.

Read [architecture and scaling](docs/architecture.md), [deployment](docs/deployment.md), and [contributing](CONTRIBUTING.md) before extending the starter for production.

## Commands

| Command                       | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `bun run dev`                 | Watch both apps and run the local engine                                |
| `bun run check`               | TypeScript and Svelte diagnostics                                       |
| `bun run test`                | API boundaries, limits, provider selection, and adapter lifecycle tests |
| `bun run build`               | Package adapter and build the SvelteKit app for the Bun server          |
| `bun run validate`            | Checks, unit tests, and production build                                |
| `bun run test:integration`    | Real server + isolated engine: edge, actors, entities, chat, restart    |
| `bun run test:e2e:production` | Build and run the same browser suites against the production Bun server |
| `bun run test:deployment URL` | Acceptance against a deployed origin; no AI spending                    |
| `bun run test:e2e`            | Real Chromium tests with a local provider fixture; no paid calls        |
| `bun run test:smoke`          | Exercise a running local API and engine without AI spending             |
| `bun run format`              | Format maintained source and docs                                       |

Before the first browser test, run `bunx playwright install chromium` (on Linux CI: `bunx playwright install --with-deps chromium`). Browser tests use a temporary engine data directory and start their own processes on ports 5174, 3002, 6540, 6541, and 6542. They test the counter homepage, the `/data` browser with two people sharing an organization live (invite, accept, projects, tasks, comments, presence, a CSV download, task and project deletion, removal closing access), session restoration and isolation, idempotent actor creation, native CSS 3D actor controls, two-tab socket/HTTP updates, mobile touch and keyboard flows, response ownership, connection retry, and input limits. A separate local provider fixture verifies the optional chat actor’s streamed socket events, cancellation, provider failure/retry, and conversation isolation. They do not call a paid model.

`bun run test:integration` starts an isolated engine and the real server (on its own ports and temp directory) and talks to it only through the public `/rivet` edge, the way a browser does. It covers the edge's admin denials and origin check, counter actions and events, the entity actors (refused unsigned principals, token expiry and reconnect, the reserved `system` id, server-only actions, write limits, paged comments, presence, the export workflow and its expiry, project deletion), the chat and session actors with the local model fixture, and state across a server restart. Set `KEEP_HARNESS_DIAGNOSTICS=1` to keep its logs.

## Configuration

The root `.env` is optional; existing environment values win. [`.env.example`](.env.example) lists every variable. The common ones:

| Variable                                           | Default / purpose                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `PORT`, `HOST`                                     | `3001`, `127.0.0.1`; the image uses `8080` and `::`                               |
| `ROLE`                                             | `all`, `app`, `engine`, `runner` or `front`; see [deployment](docs/deployment.md) |
| `PUBLIC_ORIGIN`, `WEB_ORIGINS`                     | Public site origin, plus extra allowed browser origins (local Vite by default)    |
| `RIVET_RUN_ENGINE_PORT`                            | `6440`; the local development engine                                              |
| `RIVET_ENDPOINT`, `RIVET_TOKEN`, `RIVET_NAMESPACE` | Server-only engine connection. Unset locally                                      |
| `S3_*`                                             | The bucket the production engine cluster runs on (https only)                     |
| `ENTITY_SECRET`                                    | Derives the token keys; required in production, identical on every replica        |
| `ENTITY_EXPORT_TTL_SECONDS`                        | `3600`; how long a CSV export is kept before its actor deletes it                 |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`           | Optional OpenRouter provider                                                      |
| `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_MODEL`     | Optional Gemini provider                                                          |
| `ACTOR_TOKEN`                                      | Optional **public demo parameter**, returned to the browser; not authentication   |

The server exposes `/api/health` (liveness), `/api/health/actors` (runner registered; the deploy gate), `/api/ready` (provider configuration), `/api/client-config`, and `POST /api/counters/:name/increment` with JSON `{ "by": 1 }`. Browsers open actor sockets through `/rivet` on the same origin; the relay denies engine administration and never forwards the engine token.

**This starter is an open local demo.** Origins and the public demo token do not authenticate a user. Before exposing private data or a funded AI provider, add verified user identity, authorize actor keys on the server, enforce quotas, and protect both HTTP and WebSocket paths. See the concrete [deployment checklist](docs/deployment.md).

## Troubleshooting

| Symptom                                  | Check                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| “Your playground is almost ready”        | Start the server (`bun run dev`); check port 3001; use **Try connection again**             |
| Socket never connects                    | Check server logs, free ports, and that the page origin is in `PUBLIC_ORIGIN`/`WEB_ORIGINS` |
| Boot hangs: "config operation timed out" | `S3_ENDPOINT` must be https and reachable; see [deployment](docs/deployment.md)             |
| AI disabled                              | Set one provider key in root `.env`, restart the API, and reload                            |
| AI error                                 | Check server logs and model permissions; provider details are not returned to the browser   |
| Native binding/engine error              | Use Bun 1.4.4+, reinstall with the lockfile, and check network access                       |
| Lost old chat messages                   | The transcript is deliberately bounded; page a table, as task comments do, for full history |

Rivet upstream: [quickstart](https://rivet.dev/actors/docs/quickstart/), [SQLite](https://rivet.dev/actors/docs/sqlite/), [workflows](https://rivet.dev/docs/actors/workflows), [deployment](https://rivet.dev/docs/). Svelte: [SvelteKit docs](https://svelte.dev/docs/kit) and [state management](https://svelte.dev/docs/kit/state-management).

## License

MIT for the starter. `packages/rivetkit-svelte` is Apache-2.0; preserve its license and attribution when extracting it.

## Deploy to Railway

One image, three replicas, one bucket, via [Railway infrastructure as code](.railway/railway.ts). Each replica is a Rivet engine node plus the app. The [deployment guide](docs/deployment.md) covers roles, the `all`/`split` topologies, deploy overlap and drain, the rehearsed rotation results, and the risks you accept. No Rivet Cloud account or AI key is required.
