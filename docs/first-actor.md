# From actor to Svelte

The smallest path through this template is the counter. Read these files in order:

1. `apps/api/src/actors/counter.ts`
2. `apps/api/src/actors.ts`
3. `apps/web/src/lib/components/RivetProvider.svelte`
4. `apps/web/src/lib/view-models/counter-view-model.svelte.ts`
5. `apps/web/src/lib/components/ActorLab.svelte`

## 1. Define state, commands, and notifications

```ts
import { actor, event, UserError } from "rivetkit";

export const counter = actor({
  state: { count: 0 },
  events: { newCount: event<number>() },
  actions: {
    getCount: (c) => c.state.count,
    increment: (c, by: number) => {
      if (!Number.isInteger(by) || by < 1 || by > 100) {
        throw new UserError("Use a whole number from 1 to 100.");
      }
      c.state.count += by;
      c.broadcast("newCount", c.state.count);
      return c.state.count;
    },
  },
});
```

`c.state` is persisted by Rivet. `c.vars` is temporary and is recreated after sleep or restart. Events notify connected consumers; they are not a replayable history. A fresh connection must fetch a snapshot. Runtime validation matters because TypeScript cannot validate a caller's network payload.

The actual counter also checks demo connection parameters and integer overflow. Keep those checks when editing it.

## 2. Register the definition

The registry in `apps/api/src/actors.ts` passes `{ counter, chat, session }` to `setup({ use: ... })`. A definition describes a kind of actor. `getOrCreate(["counter", "demo"])` selects one instance of that kind. A different key selects independent state.

The homepage uses a visitor's session actor to create and remember counter keys. See `apps/api/src/actors/session.ts` for typed actor-to-actor calls and `apps/web/src/lib/view-models/session-view-model.svelte.ts` for restoration. The session stores membership; each counter still owns its value. The direct counter example below works independently of the session registry.

Register a new actor next to the existing definitions. The exported registry type gives clients their available action names, arguments, and return types.

## 3. Provide a browser client

`DemoLoader` fetches public connection configuration after mounting. It renders `RivetProvider` only after that succeeds, and offers retry if the API is unavailable. The static page still renders during SSR.

`RivetProvider` creates a client, installs it into the app-local `createRivetContext<typeof registry>()`, and disposes it when removed. Capture the context during component initialization; do not call `getContext` later from a click handler. Avoid server-module singletons holding user credentials.

## 4. Put connection behavior in a view model

`CounterViewModel` captures the context during initialization and owns an actor handle. Its `connect()` method mounts the handle and returns cleanup. The component calls it from `onMount`.

The view model:

- subscribes to `newCount` before opening the connection;
- reads `getCount()` on every connection, including reconnections;
- guards asynchronous responses so an old actor cannot overwrite a newly selected actor;
- distinguishes an unknown count from a confirmed zero with `hasValue`, and exposes snapshot pending/error state;
- exposes reactive fields and methods to the panel;
- unmounts and disposes the handle when the component leaves the page.

The counter is monotonic, so it can safely keep the larger of a snapshot and a newly received event. For state that can move backward, use server revisions or event buffering instead. The chat shows buffering around an atomic snapshot.

## 5. Render and call

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { CounterViewModel } from "#lib/view-models/index.js";

  const counter = new CounterViewModel();
  onMount(() => counter.connect());
</script>

<output>
  {counter.hasValue
    ? counter.count
    : counter.snapshotError
      ? "Count unavailable"
      : "Loading saved count…"}
</output>
{#if counter.hasValue && (!counter.connected || counter.snapshotPending)}
  <p>Last known count; waiting for a fresh connection snapshot.</p>
{/if}
<button
  disabled={!counter.connected || counter.actor?.isMutating}
  onclick={() => counter.increment()}>Increment</button
>

{#if counter.snapshotError || counter.error}
  <p role="alert">{counter.snapshotError ?? counter.error}</p>
{/if}
```

Render this beneath `RivetProvider`, as the homepage playground does. It should never initialize before the provider exists. The component renders only a confirmed value; connection alone does not establish that the saved count has loaded. The view model accepts action and HTTP responses as well as `newCount` events. A successful response does not prove that a socket event was observed.

The playground’s **Svelte connection** example shows component-owned `useActor` with a reactive key; **View model** shows explicit `createReactiveActor` ownership. Both subscribe before fetching a snapshot, reject late results from an old connection, and render an unknown value until a snapshot or event confirms it. Their `Math.max` reconciliation is specific to this increment-only counter. The application view model above also owns HTTP, re-keying, snapshot status, and connection recovery.

## Try these changes

- Add a second counter key and verify the values are independent.
- Add an action that changes state, declares a typed event, and validates its arguments.
- For collaborative documents, use `[organizationId, documentId]` and verify the caller's membership on the server. Knowing an actor key is not authorization.
- For a growing collection, move the data into actor-local SQLite and add paginated reads instead of expanding `c.state`.

Run `bun run validate` and `bun run test:e2e` after changing the contract.
