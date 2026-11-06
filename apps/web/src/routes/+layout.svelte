<script lang="ts">
  import "../app.css";
  let { children } = $props();
</script>

<svelte:head>
  <title>rivet + svelte</title>
  <meta
    name="description"
    content="Change one. One at a time. Explore independent Rivet Actors in a live Svelte playground, then build with this community-made SvelteKit starter."
  />
  <meta name="theme-color" content="#f4f5f2" />
  <meta property="og:title" content="rivet + svelte" />
  <meta
    property="og:description"
    content="Independent actors. Live Svelte views. A community-built starter you can make your own."
  />
  <meta property="og:type" content="website" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
</svelte:head>

{@render children()}
