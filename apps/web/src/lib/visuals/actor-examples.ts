/** The package's two ownership patterns: useActor for components, mount for view models. */
export function actorExamples(kind: "counter" | "chat", key: string) {
  const actorKey = JSON.stringify(key);
  if (kind === "counter") return counterExamples(actorKey);
  const isChat = kind === "chat";
  const className = isChat ? "ChatViewModel" : "CounterViewModel";
  const file = isChat ? "chat" : "counter";
  const action = isChat
    ? 'actor.sendMessage("Hello from Svelte")'
    : "actor.increment(1)";
  const label = isChat ? "Send hello" : "Increment";
  const component = `<script lang="ts">
  import { getRivet } from "#lib/rivet.js";
  import { actorSocketOptions } from "#lib/actor-socket.js";

  let { actorKey = ${actorKey} }: { actorKey?: string } = $props();
  const options = actorSocketOptions();

  // The adapter owns connection and cleanup.
  const actor = getRivet().useActor<"${kind}">(() => ({
    name: "${kind}",
    key: ["${kind}", actorKey],
    ...options,
  }));
</script>

<button
  disabled={!actor.isConnected || actor.isMutating}
  onclick={() => ${action}}
>
  ${label}
</button>

{#if actor.lastActionError}
  <p role="alert">{actor.lastActionError.message}</p>
{/if}`;

  const viewModel = `// ${file}.svelte.ts
import { getRivet } from "#lib/rivet.js";
import { actorSocketOptions } from "#lib/actor-socket.js";

export class ${className} {
  actor = getRivet().createReactiveActor({
    name: "${kind}",
    key: ["${kind}", ${actorKey}],
    ...actorSocketOptions(),
  });
${isChat ? '\n  draft = $state("");\n' : ""}
  ${isChat ? 'async send() {\n    const text = this.draft.trim();\n    if (!text) return;\n    const result = await this.actor.sendMessage(text);\n    if (result?.accepted) this.draft = "";\n  }' : "increment() {\n    return this.actor.increment(1);\n  }"}

  mount() {
    const release = this.actor.mount();
    return () => {
      release();
      this.actor.dispose();
    };
  }
}

<!-- ${isChat ? "Chat" : "Counter"}.svelte -->
<script lang="ts">
  import { onMount } from "svelte";
  import { ${className} } from "#lib/${file}.svelte.js";

  // Resolve the typed context during component initialization.
  const model = new ${className}();
  onMount(() => model.mount());
</script>
${isChat ? '\n<input bind:value={model.draft} aria-label="Message" />\n' : ""}
<button
  disabled={!model.actor.isConnected || model.actor.isMutating}
  onclick={() => model.${isChat ? "send()" : "increment()"}}
>
  ${isChat ? "Send message" : label}
</button>

{#if model.actor.lastActionError}
  <p role="alert">{model.actor.lastActionError.message}</p>
{/if}`;
  return { component, viewModel };
}

/** Counts only increase here; other state needs revisions or event buffering. */
function counterExamples(actorKey: string) {
  const component = `<script lang="ts">
  import { getRivet } from "#lib/rivet.js";
  import { actorSocketOptions } from "#lib/actor-socket.js";

  let { actorKey = ${actorKey} }: { actorKey?: string } = $props();
  const options = actorSocketOptions();
  const actor = getRivet().useActor<"counter">(() => ({
    name: "counter",
    key: ["counter", actorKey],
    ...options,
  }));
  let view = $state.raw<{
    key: string;
    connection: typeof actor.connection;
    value: number | null;
    error: string | null;
  } | null>(null);
  const currentView = $derived(
    view?.key === actorKey && view.connection === actor.connection ? view : null
  );

  function receive(next: number) {
    if (!currentView) return;
    // This counter only increases; a late snapshot cannot lower its value.
    view = { ...currentView, value: Math.max(currentView.value ?? next, next) };
  }
  // Register during initialization, before the snapshot effect.
  actor.onEvent("newCount", receive);

  $effect(() => {
    const key = actorKey;
    const connection = actor.connection;
    view = { key, connection, value: null, error: null };
    if (!actor.isConnected || !connection) return;

    let active = true;
    const current = () => active && actorKey === key &&
      actor.connection === connection;
    void actor.getCount().then((next) => {
      if (!current()) return;
      if (next == null) throw new Error("Snapshot unavailable");
      receive(next);
    }).catch(() => {
      if (current() && view) {
        view = { ...view, error: "Could not read the saved count." };
      }
    });
    return () => { active = false; };
  });
  // useActor owns socket/listener cleanup on re-key and teardown.
</script>

<output>{currentView?.value ?? (currentView?.error ? "Count unavailable" : "Loading count…")}</output>
<button
  disabled={!actor.isConnected || actor.isMutating}
  onclick={() => actor.increment(1)}
>Increment</button>

{#if currentView?.error || actor.lastActionError}
  <p role="alert">{currentView?.error ?? actor.lastActionError?.message}</p>
{/if}`;

  const viewModel = `// counter.svelte.ts — one model per actor key
import { getRivet } from "#lib/rivet.js";
import { actorSocketOptions } from "#lib/actor-socket.js";

export class CounterViewModel {
  count = $state<number | null>(null);
  snapshotError = $state<string | null>(null);
  actor = getRivet().createReactiveActor({
    name: "counter",
    key: ["counter", ${actorKey}],
    ...actorSocketOptions(),
  });

  constructor() {
    $effect(() => {
      const connection = this.actor.connection;
      this.count = null;
      this.snapshotError = null;
      if (!this.actor.isConnected || !connection) return;

      let active = true;
      const current = () => active && this.actor.connection === connection;
      const receive = (next: number) => {
        if (current()) this.count = Math.max(this.count ?? next, next);
      };
      const stop = this.actor.onEvent("newCount", receive);
      void this.actor.getCount().then((next) => {
        if (next == null) throw new Error("Snapshot unavailable");
        receive(next);
      }).catch(() => {
        if (current()) this.snapshotError = "Could not read the saved count.";
      });
      return () => { active = false; stop(); };
    });
  }

  increment() { return this.actor.increment(1); }

  mount() {
    const release = this.actor.mount();
    return () => {
      release();
      this.actor.dispose();
    };
  }
}

<!-- Counter.svelte -->
<script lang="ts">
  import { onMount } from "svelte";
  import { CounterViewModel } from "#lib/counter.svelte.js";

  const model = new CounterViewModel();
  onMount(() => model.mount());
</script>

<output>{model.count ?? (model.snapshotError ? "Count unavailable" : "Loading count…")}</output>
<button
  disabled={!model.actor.isConnected || model.actor.isMutating}
  onclick={() => model.increment()}
>Increment</button>

{#if model.snapshotError || model.actor.lastActionError}
  <p role="alert">{model.snapshotError ?? model.actor.lastActionError?.message}</p>
{/if}`;
  return { component, viewModel };
}
