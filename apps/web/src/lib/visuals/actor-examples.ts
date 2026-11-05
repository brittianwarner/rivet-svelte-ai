/** The package's two ownership patterns: useActor for components, mount for view models. */
export function actorExamples(kind: "counter" | "chat", key: string) {
  const actorKey = JSON.stringify(key);
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
