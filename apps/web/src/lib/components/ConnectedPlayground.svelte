<script lang="ts">
  import type { ClientConfig } from "@example/wire";
  import RivetProvider from "./RivetProvider.svelte";
  import Playground from "./Playground.svelte";
  let { config }: { config: ClientConfig } = $props();
</script>

<RivetProvider {config}><Playground /></RivetProvider>
