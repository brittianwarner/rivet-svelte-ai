<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { PrincipalViewModel, setPrincipal } from "#lib/data/index.js";
  import SignIn from "./SignIn.svelte";
  import SignedIn from "./SignedIn.svelte";

  let { children }: { children: Snippet } = $props();

  const principal = new PrincipalViewModel();
  setPrincipal(principal);
  onMount(() => {
    void principal.start();
  });
</script>

{#if principal.current}
  <!-- A new person means new sockets: every actor reconnects with their token. -->
  {#key principal.current.sub}
    <SignedIn>{@render children()}</SignedIn>
  {/key}
{:else}
  <SignIn />
{/if}
