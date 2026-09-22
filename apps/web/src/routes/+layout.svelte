<script lang="ts">
  import { onMount } from "svelte";
  import RivetProvider from "$lib/components/RivetProvider.svelte";
  import { rivetReady } from "$lib/rivet";
  import "../app.css";

  let { children } = $props();
  let ready = $state(false);
  let loadError = $state<string | null>(null);

  onMount(() => {
    void rivetReady.then(
      () => {
        ready = true;
      },
      (error: unknown) => {
        loadError = error instanceof Error ? error.message : "Could not connect.";
      },
    );
  });
</script>

<svelte:head>
  <title>Rivet chat</title>
</svelte:head>

{#if loadError}
  <p class="error page">{loadError}</p>
{:else if ready}
  <RivetProvider>
    {@render children()}
  </RivetProvider>
{:else}
  <p class="status page">Connecting…</p>
{/if}
