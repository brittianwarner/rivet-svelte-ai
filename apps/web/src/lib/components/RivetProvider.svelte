<script lang="ts">
  import { rivetContext, setActorToken, setRivetClient } from "#lib/rivet.js";
  import type { ClientConfig } from "@example/wire";
  import { onDestroy, untrack, type Snippet } from "svelte";

  import { createClient } from "@rivetkit/svelte";
  import type { AppRegistry } from "@example/actors";

  let { config, children }: { config: ClientConfig; children: Snippet } =
    $props();
  // One client per provider lifetime. The parent remounts when configuration changes.
  const initial = untrack(() => config);
  // The browser only ever talks to this origin's /rivet edge. The server
  // attaches the engine credential upstream, so nothing secret reaches here.
  const client = createClient<AppRegistry>({
    endpoint: initial.rivetEndpoint,
    namespace: initial.rivetNamespace,
    // The edge denies /actors; actors resolve through the gateway query path.
    gateway: { skipReadyWait: true },
    disableMetadataLookup: true,
  });
  rivetContext.setupWithClient(client);
  setRivetClient(client);
  setActorToken(initial.actorToken);
  onDestroy(() => {
    void client.dispose();
  });
</script>

{@render children()}
