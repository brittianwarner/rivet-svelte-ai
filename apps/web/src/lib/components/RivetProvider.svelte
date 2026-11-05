<script lang="ts">
  import { rivetContext, setActorToken } from "#lib/rivet.js";
  import type { ClientConfig } from "@example/wire";
  import { onDestroy, untrack, type Snippet } from "svelte";

  import { createClient } from "@rivetkit/svelte";
  import type { registry } from "@example/api/actors";

  let { config, children }: { config: ClientConfig; children: Snippet } =
    $props();
  // One client per provider lifetime. The parent remounts when configuration changes.
  const initial = untrack(() => config);
  const client = createClient<typeof registry>(initial.rivetEndpoint);
  rivetContext.setupWithClient(client);
  setActorToken(initial.actorToken);
  onDestroy(() => {
    void client.dispose();
  });
</script>

{@render children()}
