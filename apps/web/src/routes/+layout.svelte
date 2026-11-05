<script lang="ts">
  import "../app.css";
  let { children } = $props();
</script>

<svelte:head>
  <title>rivet + svelte</title>
  <meta
    name="description"
    content="Build apps that stay in sync with Rivet Actors, Svelte 5, and SvelteKit. Explore the live playground, then make this community-built starter your own."
  />
</svelte:head>

{@render children()}
