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
  let nextTokenAttempt = 0;
  const client = createClient<typeof registry>({
    endpoint: initial.rivetEndpoint,
    namespace: initial.rivetNamespace,
    ...(initial.authenticatedEngine
      ? {
          getToken: async () => {
            // Failed token requests must not turn reconnects into a tight retry loop.
            const delay = nextTokenAttempt - Date.now();
            if (delay > 0)
              await new Promise((resolve) => setTimeout(resolve, delay));
            nextTokenAttempt = Date.now() + 2_000;
            const response = await fetch("/api/client-token", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
              signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok)
              throw new Error(
                "Could not connect to the actor service. Please retry.",
              );
            const result = await response.json();
            if (typeof result.token !== "string" || !result.token)
              throw new Error("Invalid actor service credential.");
            nextTokenAttempt = 0;
            return result.token;
          },
        }
      : {}),
  });
  rivetContext.setupWithClient(client);
  setActorToken(initial.actorToken);
  onDestroy(() => {
    void client.dispose();
  });
</script>

{@render children()}
