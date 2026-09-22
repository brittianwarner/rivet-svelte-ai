# Rivet chat

One conversation is one Rivet actor. A Node Hono process runs the actors. A Node SvelteKit app renders them through `@rivetkit/svelte`. The Vercel AI SDK runs inside the actor.

Bun installs packages. Node 22 or newer runs both apps.

## Start

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY.
bun install
bun run dev
```

Open http://127.0.0.1:5173.

The page is ready when it shows a provider name and **Increment on socket** changes the count. Chat streams after a key is set. With no key, the counter still works and chat names the variable to set.

A non-empty `OPENROUTER_API_KEY` uses OpenRouter. A blank OpenRouter key uses Gemini.

## Chat path

1. The page calls `ChatViewModel.send()`.
2. That calls the `sendMessage` actor action on the socket.
3. The action checks the text, queues it, and returns.
4. The actor `run` loop calls `streamText` and stores each token in actor state.
5. Each event includes the full assistant text so far. Every time the socket connects, including after a drop, the view model replaces the screen with `getHistory()`.

`keepAwake` holds the actor until the turn finishes, so closing the tab does not cancel the reply. The model key stays in the API process.

## Map

| Path | Owns |
| --- | --- |
| `apps/api/src/actors.ts` | `counter` and `chat` actors, the queue loop, `streamText` |
| `apps/api/src/model.ts` | OpenRouter when its key is set, otherwise Gemini |
| `apps/api/src/index.ts` | Hono routes and `registry.start()` |
| `apps/web/src/lib/view-models/chat-view-model.svelte.ts` | Chat socket, `sendMessage`, `cancel`, `getHistory` |
| `apps/web/src/lib/view-models/counter-view-model.svelte.ts` | Counter socket and the Hono increment |
| `apps/web/src/routes/+page.svelte` | Renders the view models |
| `packages/rivetkit-svelte` | Svelte 5 Rivet client. It does not import the AI SDK |
| `packages/wire` | Shared message types |

Pages and panels call view model methods. They do not import `rivetkit`.

## HTTP

The browser calls `/api/*` on the web app. `apps/web/src/hooks.server.ts` forwards that to Hono on port 3001. Actor sockets use the URL from `GET /api/client-config`. The local engine defaults to `http://127.0.0.1:6440`.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/health` | `{ ok: true }` |
| GET | `/ready` | `{ provider, model }` |
| GET | `/client-config` | `{ rivetEndpoint, actorToken }` |
| POST | `/counters/:name/increment` | `{ count }` |
| ALL | `/api/rivet/*` | Engine callback. The browser does not call this |

## Environment

| Variable | Role |
| --- | --- |
| `OPENROUTER_API_KEY` | When non-empty, chat uses OpenRouter |
| `OPENROUTER_MODEL` | Default `google/gemini-3.8-flash` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Used when the OpenRouter key is blank |
| `GEMINI_MODEL` | Default `gemini-3.8-flash` |
| `ACTOR_TOKEN` | Optional demo gate. The browser receives it. Not a model key |
| `RIVET_PUBLIC_ENDPOINT` | Where the browser opens actor sockets |
| `RIVET_ENDPOINT`, `RIVET_TOKEN`, `RIVET_NAMESPACE` | Rivet Cloud. Leave unset to run the local engine |

## Checks

```bash
bun run check
bun run test
```

## License

MIT for this example. `packages/rivetkit-svelte` is Apache-2.0. See `packages/rivetkit-svelte/LICENSE`.
