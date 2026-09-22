<script lang="ts">
  import { getRivet, rivetContext } from "$lib/rivet";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();

  // Must run during component init. The client already exists by the time
  // this provider is mounted.
  rivetContext.set(getRivet());
</script>

{@render children()}
