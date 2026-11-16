<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    ConnectionRegistry,
    UserViewModel,
    getPrincipal,
    setConnections,
    setUser,
  } from "#lib/data/index.js";
  import DataShell from "./DataShell.svelte";

  let { children }: { children: Snippet } = $props();

  const principal = getPrincipal();
  // DataApp keys this component on the person, so the id is fixed for its life.
  const user = new UserViewModel(principal.current!.sub);
  const connections = new ConnectionRegistry();
  setUser(user);
  setConnections(connections);

  $effect(() => user.connect());
  $effect(() => connections.track("user", user));
</script>

<DataShell>{@render children()}</DataShell>
