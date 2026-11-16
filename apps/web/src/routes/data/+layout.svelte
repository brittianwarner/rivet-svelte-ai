<script lang="ts">
  import RivetProvider from "#lib/components/RivetProvider.svelte";
  import DataApp from "#lib/components/data/DataApp.svelte";

  let { data, children } = $props();
</script>

<svelte:head>
  <title>Data · rivet + svelte</title>
  <meta
    name="description"
    content="Browse organizations, members, and projects. Each one is a live Rivet Actor."
  />
</svelte:head>

{#key data.config}
  <RivetProvider config={data.config}>
    <DataApp>{@render children()}</DataApp>
  </RivetProvider>
{/key}
