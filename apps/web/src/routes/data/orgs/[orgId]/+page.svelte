<script lang="ts">
  import { page } from "$app/state";
  import OrganizationPage from "#lib/components/data/OrganizationPage.svelte";
</script>

<!-- One view model per organization: switching orgs swaps the socket. -->
{#key page.params.orgId}
  <OrganizationPage orgId={page.params.orgId!} />
{/key}
