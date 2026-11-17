<script lang="ts">
  import { page } from "$app/state";
  import OrganizationScope from "#lib/components/data/OrganizationScope.svelte";

  let { children } = $props();
</script>

<!-- One organization per key: its pages and projects share one socket. -->
{#key page.params.orgId}
  <OrganizationScope orgId={page.params.orgId!}>
    {@render children()}
  </OrganizationScope>
{/key}
