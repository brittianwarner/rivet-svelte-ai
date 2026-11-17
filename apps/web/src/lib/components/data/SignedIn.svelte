<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    ConnectionRegistry,
    OrganizationCache,
    UserViewModel,
    entityDeps,
    getPrincipal,
    setConnections,
    setOrganizations,
    setUser,
  } from "#lib/data/index.js";
  import DataShell from "./DataShell.svelte";

  let { children }: { children: Snippet } = $props();

  const principal = getPrincipal();
  const deps = entityDeps();
  // DataApp keys this component on the person, so the id is fixed for its life.
  const user = new UserViewModel(principal.current!.sub, deps);
  const organizations = new OrganizationCache(deps);
  const connections = new ConnectionRegistry();
  setUser(user);
  setOrganizations(organizations);
  setConnections(connections);

  $effect(() => user.connect());
  $effect(() => connections.track("user", user));
  // Someone else signing in gets fresh sockets with their own token.
  $effect(() => () => organizations.dispose());
</script>

<DataShell>{@render children()}</DataShell>
