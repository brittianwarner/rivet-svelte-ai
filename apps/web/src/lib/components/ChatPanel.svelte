<script lang="ts">
  import type { ChatViewModel } from "#lib/view-models/chat-view-model.svelte.js";
  import type { ProviderViewModel } from "#lib/view-models/provider-view-model.svelte.js";
  import { MAX_CHAT_MESSAGE_LENGTH } from "@example/wire";
  let { chat, provider }: { chat: ChatViewModel; provider: ProviderViewModel } =
    $props();
  const busy = $derived(chat.turn === "thinking" || chat.turn === "queued");
  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void chat.send();
  }
</script>

<section class="demo-card chat-card" aria-labelledby="chat-title">
  <div class="card-heading">
    <span class="eyebrow">02 / STREAMING AI</span><span class="connection-badge"
      ><span class:online={chat.connected} class="status-dot"
      ></span>{chat.connStatus}</span
    >
  </div>
  <h3 id="chat-title">A conversation with memory.</h3>
  <p>
    One actor per conversation. Reload this tab to restore its recent messages.
  </p>
  {#if provider.provider === "none"}<div class="setup-note">
      To enable AI, copy <code>.env.example</code> to <code>.env</code>, add a
      provider key, and restart the API. The counter works without one.
    </div>{:else}<p class="provider-label">
      {provider.provider} / {provider.model}
    </p>{/if}
  {#if provider.error}<p class="error" role="alert">{provider.error}</p>{/if}
  <!-- Scrollable history must remain keyboard accessible. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="transcript" role="region" aria-label="Conversation" tabindex="0">
    {#if chat.messages.length === 0}<div class="empty-chat">
        <span aria-hidden="true">✳</span>
        <p>A little state goes a long way.</p>
        <small>Your next idea starts here.</small>
      </div>{/if}
    {#each chat.messages as message (message.id)}<article
        class={["message", message.role]}
      >
        <div class="role">{message.role === "user" ? "You" : "Assistant"}</div>
        <p>{message.content || "Thinking…"}</p>
      </article>{/each}
  </div>
  <p class="turn-status" role="status">
    {busy
      ? chat.turn === "queued"
        ? "Message queued…"
        : "Writing a reply…"
      : "Ready for your next thought."}
  </p>
  {#if chat.error}<p class="error" role="alert">{chat.error}</p>{/if}
  <form onsubmit={onSubmit}>
    <label class="sr-only" for="draft">Message</label><textarea
      id="draft"
      bind:value={chat.draft}
      maxlength={MAX_CHAT_MESSAGE_LENGTH}
      placeholder="What would you like to build?"
      rows="2"></textarea>
    <div class="row">
      <button
        type="submit"
        disabled={!chat.connected ||
          chat.sending ||
          busy ||
          provider.provider === "none" ||
          !chat.draft.trim()}>Send message ↗</button
      >{#if busy}<button
          type="button"
          class="secondary"
          disabled={chat.turn !== "thinking"}
          onclick={() => void chat.stop()}>Stop</button
        >{/if}<button
        type="button"
        class="text-button"
        onclick={() => chat.newChat()}>New chat</button
      >
    </div>
  </form>
  <div class="card-footnote">
    <code>actors/chat.ts</code><span>Queue + bounded history + AI</span>
  </div>
</section>
