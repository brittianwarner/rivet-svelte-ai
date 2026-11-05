<script lang="ts">
  import { onMount, type Component } from "svelte";
  import type { ClientConfig } from "@example/wire";

  let Connected = $state.raw<Component<{ config: ClientConfig }> | null>(null);
  let config = $state.raw<ClientConfig | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let controller: AbortController | undefined;

  async function connect() {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    loading = true;
    error = null;
    try {
      const response = await fetch("/api/client-config", {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok)
        throw new Error("Start the API with bun run dev, then try again.");
      const next = (await response.json()) as ClientConfig;
      const endpoint = new URL(next.rivetEndpoint);
      if (!["http:", "https:"].includes(endpoint.protocol))
        throw new Error("Invalid Rivet endpoint.");
      const module = await import("./ConnectedPlayground.svelte");
      if (!request.signal.aborted) {
        Connected = module.default;
        config = next;
      }
    } catch (cause) {
      if (!request.signal.aborted)
        error =
          cause instanceof Error
            ? cause.message
            : "Could not connect to the API.";
    } finally {
      if (!request.signal.aborted) loading = false;
    }
  }

  onMount(() => {
    void connect();
    return () => controller?.abort();
  });
</script>

{#if config && Connected}
  {#key config}<Connected {config} />{/key}
{:else}
  <div class="connection-placeholder" aria-live="polite">
    <span class="eyebrow">ACTOR PLAYGROUND</span>
    <h3>
      {loading
        ? "Connecting to your actors…"
        : "Your playground is almost ready."}
    </h3>
    <p>
      {error ??
        "Connecting to Rivet. This counter demo needs no account or AI key."}
    </p>
    {#if !loading}<button onclick={() => void connect()}
        >Try connection again <span aria-hidden="true">↗</span></button
      >{/if}
    <noscript
      >Enable JavaScript to connect to the interactive examples.</noscript
    >
  </div>
{/if}
