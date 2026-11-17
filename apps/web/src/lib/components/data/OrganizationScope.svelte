<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    getConnections,
    getOrganizations,
    setOrganization,
  } from "#lib/data/index.js";

  let { orgId, children }: { orgId: string; children: Snippet } = $props();

  // The layout keys this component on orgId, so it is fixed for its life.
  // svelte-ignore state_referenced_locally
  const id = orgId;
  const organizations = getOrganizations();
  const org = organizations.get(id);
  const connections = getConnections();
  setOrganization(org);

  // Held for every page under this organization: opening a project and
  // coming back reuses the same socket and snapshot.
  $effect(() => organizations.hold(id));
  $effect(() => connections.track(`organization/${id}`, org));
</script>

{@render children()}
