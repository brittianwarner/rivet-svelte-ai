# rivet + svelte

Build apps that stay in sync with **RivetKit 3.0.1**, **Svelte 5**, and **SvelteKit 3**. Start with a working app: independent counter actors, live Svelte components, and a session that remembers what you create. Try the 3D playground, inspect the code, then make it yours.

This is a community-built starter with a workspace Svelte adapter. The learning page renders on the server; actor connections open in the browser. An optional streaming chat implementation is included in the repository.

- A local Rivet engine starts automatically. No Docker, account, or AI key needed for the counter.
- Actor actions and events stay typed from the API registry to Svelte.
- Each actor has its own persistent state; each browser provider owns its client and cleans it up.
- Small actors, shared contracts, and view models give new features a clear home.
- Type checks, unit tests, a production build, and real-browser acceptance tests are included.

## Start here

Install [Node.js](https://nodejs.org/) **26** (recommended; also supports 22.22.2+ and 24.15.0+) and [Bun](https://bun.sh/) **1.4.4**. Bun manages the workspace; Node runs the apps and Rivet's native bindings.

```bash
git clone https://github.com/brittianwarner/rivet-svelte-ai.git
cd rivet-svelte-ai
bun install --frozen-lockfile
bun run dev
```

Open **http://127.0.0.1:5173**. Click **+ Increment**, then open a second tab. Your browser gets a session actor that remembers the counters you create. **Add actor** creates an independent counter in that session; another tab in the same browser restores the same registry. **+ Via HTTP** reaches the selected counter through the API. Use **Actor key → Connect** to attach a known counter to your session.

The first install/start needs internet access for dependencies and the native engine. The default ports are 5173 (web), 3001 (API), 6440 (engine), and 6441 (Rivet runner). The local Services/agentOS host is disabled because these examples do not use it.

## Your playground session

A real `session` actor holds the registry of counters for each visitor. The browser stores only a random session ID in local storage; actor keys and labels live in Rivet state. Reloading restores the registry and reconnects its counters. If storage is unavailable, the current page still works with a temporary session.

The session creates its starter counter and records every counter created or attached through the playground. Creation requests carry idempotency IDs so retries do not create duplicates. The playground limits each session to seven counters. **Disconnect actor** releases that browser connection while retaining the actor in the session; **Reconnect actor** opens it again. A reload reconnects all saved counters. The trash control in the canvas removes the selected actor from the session and closes its playground connections across tabs. It does not destroy the counter: **Undo** restores its key, label, and state. Removing every actor leaves an empty canvas after reload. The session keeps the latest 64 creation IDs to deduplicate recent retries. The connected count refers to counter sockets in this page; the session connection is shown separately.

Sessions group actors; each counter still owns its state and receives actions directly. These anonymous demo sessions are browser identities, not authenticated accounts or an authorization boundary. Clearing local storage starts a fresh session; the previous actors are not destroyed.

## Optional chat implementation

The homepage intentionally shows counter actors only. Chat is kept as reusable code: [ChatPanel.svelte](apps/web/src/lib/components/ChatPanel.svelte), [ChatViewModel](apps/web/src/lib/view-models/chat-view-model.svelte.ts), [provider setup](apps/web/src/lib/view-models/provider-view-model.svelte.ts), and the [chat actor](apps/api/src/actors/chat.ts).

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

Then configure the API's provider key:

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY, then restart bun run dev.
```

A non-empty OpenRouter key takes precedence; otherwise the app uses Gemini. Defaults are `z-ai/glm-5.3-flash` and `gemini-3.8-flash`, respectively. Both are configurable. Provider keys stay in the API process. The browser only receives the provider name, model name, and public connection configuration.

Chat IDs live in the tab's session storage. Reloading restores recent messages; **New chat** starts another actor. Closing a tab does not cancel an active reply. **Stop** cancels the active generation.

This is a bounded conversation example: at most 40 recent messages / 64 KiB of serialized transcript, 20 prompt messages, 8,000 input/output characters per message, 2,000 model output tokens, a two-minute request timeout, and one queued or active turn per actor. Older messages are discarded. Stream updates are coalesced to roughly 10 per second plus a final update.

**Recovery semantics:** reconnecting reads an atomic history/status snapshot and applies events received during that read. Actor state persists, but an external model stream is not a durable workflow. A restart can interrupt a reply, and dequeued work is not automatically replayed. On wake, an interrupted `thinking` status becomes an error. For resumable paid work, introduce a durable workflow, idempotent request IDs, and provider-specific retry handling; see [architecture](docs/architecture.md).

## Find your way around

```text
apps/
  api/src/
    actors/counter.ts       # Smallest complete actor example
    actors/session.ts       # Durable per-visitor actor registry and creation
    actors/chat.ts          # Queue, streaming, cancellation, bounded state
    actors/chat-limits.ts   # Serialized transcript budget
    actors.ts               # Registry and local engine configuration
    app.ts                  # Testable Hono routes and validation
    index.ts                # Process entry point
    env.ts / auth.ts        # Environment and demo connection checks
    model.ts                # AI provider selection
  web/src/
    routes/                 # SSR layout and getting-started page
    lib/components/         # Provider, connection loader, playground panels
    lib/view-models/        # Reactive state, actions, and reconnect snapshots
    lib/rivet.ts            # Typed, app-local Svelte context
packages/
  wire/                     # Browser-safe contracts and limits
  rivetkit-svelte/          # Workspace Svelte adapter and its tests
```

`@rivetkit/svelte` in this repository is a **workspace package**, not a claim of official Rivet support or npm publication. Keep it with the app when copying this template. [Adapter API reference](packages/rivetkit-svelte/README.md).

## Build your first feature

1. Start with [the actor-to-Svelte tutorial](docs/first-actor.md).
2. Put business rules in `apps/api/src/actors/your-feature.ts` and register the actor in `actors.ts`.
3. Use compound keys such as `[organizationId, documentId]`. Choose a key per independent unit of state; avoid a single global actor for all users.
4. Add shared DTOs to `packages/wire`. Import the API registry with `import type` so server code never enters the browser bundle.
5. Own connections in a component or view model, subscribe before loading snapshots, and release them when the component is removed.

Read [architecture and scaling](docs/architecture.md), [deployment](docs/deployment.md), and [contributing](CONTRIBUTING.md) before extending the starter for production.

## Commands

| Command                       | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `bun run dev`                 | Watch both apps and run the local engine                                 |
| `bun run check`               | TypeScript and Svelte diagnostics                                        |
| `bun run test`                | API boundaries, limits, provider selection, and adapter lifecycle tests  |
| `bun run build`               | Package adapter and build the SvelteKit Node app                         |
| `bun run validate`            | Checks, unit tests, and production build                                 |
| `bun run test:restart`        | Isolated API/runner restart and restored actor state                     |
| `bun run test:e2e:production` | Build and run the same browser suites against the production Node server |
| `bun run test:e2e`            | Real Chromium tests with a local provider fixture; no paid calls         |
| `bun run test:smoke`          | Exercise a running local API and engine without AI spending              |
| `bun run format`              | Format maintained source and docs                                        |

Before the first browser test, run `bunx playwright install chromium` (on Linux CI: `bunx playwright install --with-deps chromium`). Browser tests use a temporary engine data directory and start their own processes on ports 5174, 3002, 6540, 6541, and 6542. They test the counter homepage, session restoration and isolation, idempotent actor creation, numbered 3D selection, two-tab socket/HTTP updates, mobile layout, connection retry, and input limits. A separate local provider fixture verifies the optional chat actor’s streamed socket events, cancellation, provider failure/retry, and conversation isolation. They do not call a paid model.

`bun run test:restart` verifies checkpointed session membership and actor state across an API/runner restart while the engine stays running. The optional `FULL_ENGINE_RESTART=1` probe also requires a clean engine shutdown. Our local RivetKit 3.0.1 native-engine probe currently fails during shutdown with a singleton-coordinator fail-stop, so full engine recovery is not qualified by this template. Failed probes preserve diagnostic logs and print their location.

## Configuration

The root `.env` is optional. Existing environment values take precedence. Vite reads the root file during development; the API uses Node's dotenv parser. Production web configuration must be supplied by the host environment.

| Variable                                           | Default / purpose                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `API_PORT`                                         | `3001`; API also accepts host-provided `PORT`                                   |
| `API_HOST`                                         | `127.0.0.1`; set `0.0.0.0` in a container                                       |
| `API_ORIGIN`                                       | `http://127.0.0.1:3001`; private web-to-API URL                                 |
| `WEB_ORIGINS`                                      | `http://localhost:5173,http://127.0.0.1:5173`; allowed browser origins          |
| `RIVET_RUN_ENGINE_PORT`                            | `6440`; local runner uses the next port                                         |
| `RIVET_PUBLIC_ENDPOINT`                            | Local engine URL; required when using a remote engine                           |
| `RIVET_ENDPOINT`, `RIVET_TOKEN`, `RIVET_NAMESPACE` | Server-only remote Rivet connection configuration                               |
| `RIVET_NODE_VERSION`                               | Increasing integer release version for a hosted runner                          |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`           | Optional OpenRouter provider                                                    |
| `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_MODEL`     | Optional Gemini provider                                                        |
| `ACTOR_TOKEN`                                      | Optional **public demo parameter**, returned to the browser; not authentication |

The API exposes `/health` (process liveness), `/ready` (provider configuration, not engine readiness), `/client-config`, and `POST /counters/:name/increment` with JSON `{ "by": 1 }`. SvelteKit forwards `/api/*` to the API. Actor sockets connect directly to Rivet. The runner manages its own callback listener; Hono does not run a second serverless registry.

**This starter is an open local demo.** Origins and the public demo token do not authenticate a user. Before exposing private data or a funded AI provider, add verified user identity, authorize actor keys on the server, enforce quotas, and protect both HTTP and WebSocket paths. See the concrete [deployment checklist](docs/deployment.md).

## Troubleshooting

| Symptom                                    | Check                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| “Your playground is almost ready”          | Start the API; verify `API_ORIGIN`; use **Try connection again**                          |
| Socket never connects                      | Check engine logs, public endpoint, free ports, and exact `WEB_ORIGINS`                   |
| Remote engine configured but startup fails | Set `RIVET_PUBLIC_ENDPOINT`; never send the management secret to the browser              |
| AI disabled                                | Set one provider key in root `.env`, restart the API, and reload                          |
| AI error                                   | Check server logs and model permissions; provider details are not returned to the browser |
| Native binding/engine error                | Use supported Node 26, reinstall with the lockfile, and check network access              |
| Lost old chat messages                     | History is deliberately bounded; use SQLite and pagination for a full archive             |

Rivet upstream: [quickstart](https://rivet.dev/actors/docs/quickstart/), [state](https://rivet.dev/actors/docs/state/), [queues](https://rivet.dev/actors/docs/queues/), [SQLite](https://rivet.dev/actors/docs/sqlite/), [deployment](https://rivet.dev/docs/). Svelte: [SvelteKit docs](https://svelte.dev/docs/kit) and [state management](https://svelte.dev/docs/kit/state-management).

## License

MIT for the starter. `packages/rivetkit-svelte` is Apache-2.0; preserve its license and attribution when extracting it.

## Deploy to Railway

Self-host Rivet 3.0 alongside the web app and actor runner using [Railway infrastructure as code](.railway/railway.ts). The [deployment guide](docs/deployment.md#railway-self-hosted-rivet-30) covers provisioning, private networking, scoped browser credentials, and restart acceptance. No Rivet Cloud account or AI key is required.
