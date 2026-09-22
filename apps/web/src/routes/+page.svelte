<script lang="ts">
  import { onMount } from "svelte";
  import ChatPanel from "$lib/components/ChatPanel.svelte";
  import CounterPanel from "$lib/components/CounterPanel.svelte";
  import {
    ChatViewModel,
    CounterViewModel,
    ProviderViewModel,
  } from "$lib/view-models";

  const chat = new ChatViewModel();
  const counter = new CounterViewModel();
  const provider = new ProviderViewModel();

  const providerLabel = $derived(
    provider.provider === "none"
      ? "No model key set"
      : `${provider.provider} · ${provider.model ?? ""}`,
  );

  onMount(() => {
    const releaseChat = chat.connect();
    const releaseCounter = counter.connect();
    void provider.load();
    return () => {
      releaseChat();
      releaseCounter();
    };
  });
</script>

<main class="page">
  <h1>Rivet chat</h1>
  <p class="lede">
    One conversation is one actor. The model runs in that actor. This page only
    reads the view models.
  </p>
  <p class="meta">{providerLabel}</p>
  {#if provider.error}
    <p class="error">{provider.error}</p>
  {/if}

  <CounterPanel {counter} />
  <ChatPanel {chat} />
</main>
