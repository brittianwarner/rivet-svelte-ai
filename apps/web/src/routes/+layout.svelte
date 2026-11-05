<script lang="ts">
  import "../app.css";
  let { children } = $props();
</script>

<svelte:head>
  <title>Rivet + SvelteKit — Build something stateful.</title>
  <meta
    name="description"
    content="Start building with Rivet 3, Svelte 5, and SvelteKit. Typed actors, realtime state, and streaming AI in one practical starter."
  />
</svelte:head>

{@render children()}
