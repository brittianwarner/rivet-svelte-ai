<script lang="ts">
  import { onMount } from "svelte";
  import ChatPanel from "./ChatPanel.svelte";
  import CounterPanel from "./CounterPanel.svelte";
  import {
    ChatViewModel,
    CounterViewModel,
    ProviderViewModel,
  } from "#lib/view-models/index.js";

  const chat = new ChatViewModel();
  const counter = new CounterViewModel();
  const provider = new ProviderViewModel();

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

<div class="playground-grid">
  <CounterPanel {counter} />
  <ChatPanel {chat} {provider} />
</div>
