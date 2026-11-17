<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import {
    PrincipalViewModel,
    setPrincipal,
    type PrincipalPreload,
  } from "#lib/data/index.js";
  import SignIn from "./SignIn.svelte";
  import SignedIn from "./SignedIn.svelte";

  let { preload, children }: { preload?: PrincipalPreload; children: Snippet } =
    $props();

  // Set from the first frame, so a returning person never sees sign-in flash.
  // svelte-ignore state_referenced_locally
  const principal = new PrincipalViewModel({ restoring: !!preload?.session });
  setPrincipal(principal);
  onMount(() => {
    void principal.start(preload);
  });
</script>

{#if principal.current}
  <!-- A new person means new sockets: every actor reconnects with their token. -->
  {#key principal.current.sub}
    <SignedIn>{@render children()}</SignedIn>
  {/key}
{:else if principal.restoring}
  <!-- Signing back in: one round trip. The sign-in screen would only flash. -->
  <div class="restoring" aria-busy="true">
    <span class="sr-only" role="status">Signing you back in…</span>
  </div>
{:else}
  <SignIn />
{/if}

<style>
  .restoring {
    min-height: 100vh;
  }
</style>
