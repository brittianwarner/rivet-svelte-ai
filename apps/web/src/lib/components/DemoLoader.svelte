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
  <div class="connection-placeholder">
    <div class="loading-headline">
      <h1>
        Change <span class="loading-block">one</span>.<br /><span
          class="loading-second-line">One at a time.</span
        >
      </h1>
      <p>Each actor owns its state. Svelte brings it into view.</p>
    </div>
    <aside class="loading-client" aria-label="Playground connection">
      <span class="eyebrow">SVELTE VIEW / CONNECTION</span>
      <div class="loading-value" aria-hidden="true">—</div>
      <div class="loading-status" role="status">
        <h2>
          {loading ? "Connecting to your actors…" : "Let’s get connected."}
        </h2>
        <p>
          {error ??
            "Waiting for the playground connection. Your actor values will appear here."}
        </p>
      </div>
      {#if !loading}
        <button onclick={() => void connect()}
          >Try connection again <span aria-hidden="true">↗</span></button
        >
      {/if}
      <a class="inline-link" href="#start"
        >Start locally <span aria-hidden="true">↓</span></a
      >
      <noscript
        >Enable JavaScript to use the interactive playground. The setup guide
        below is ready to read.</noscript
      >
    </aside>
  </div>
{/if}
