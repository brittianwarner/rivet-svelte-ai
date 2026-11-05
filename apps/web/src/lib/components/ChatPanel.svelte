<script lang="ts">
  import { tick } from "svelte";
  import type { ChatViewModel } from "#lib/view-models/chat-view-model.svelte.js";
  import type { ProviderViewModel } from "#lib/view-models/provider-view-model.svelte.js";
  import { MAX_CHAT_MESSAGE_LENGTH } from "@example/wire";
  let { chat, provider }: { chat: ChatViewModel; provider: ProviderViewModel } =
    $props();
  let transcript: HTMLDivElement;
  let draftInput: HTMLTextAreaElement;
  let following = true;
  let newContent = $state(false);
  let turnVersion = "";
  const busy = $derived(chat.turn === "thinking" || chat.turn === "queued");
  const canSend = $derived(
    chat.connected &&
      !chat.sending &&
      !busy &&
      !provider.loading &&
      !provider.error &&
      provider.provider !== "none" &&
      Boolean(chat.draft.trim()),
  );
  function onDraftKey(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (canSend) void chat.send();
    }
  }
  function trackScroll(): void {
    following =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <
      48;
    if (following) newContent = false;
  }
  function showLatest(): void {
    following = true;
    newContent = false;
    transcript.scrollTop = transcript.scrollHeight;
  }
  async function newChat(): Promise<void> {
    following = true;
    newContent = false;
    chat.newChat();
    await tick();
    draftInput.focus();
  }
  $effect(() => {
    const version = chat.messages
      .map((message) => `${message.id}:${message.content.length}`)
      .join("|");
    const changed = version !== turnVersion;
    turnVersion = version;
    const frame = requestAnimationFrame(() => {
      if (!transcript) return;
      if (following) transcript.scrollTop = transcript.scrollHeight;
      else if (changed) newContent = true;
    });
    return () => cancelAnimationFrame(frame);
  });
  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    if (canSend) void chat.send();
  }
</script>

<section
  id="chat-panel"
  class="demo-card chat-card"
  aria-labelledby="chat-title"
>
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
  {#if provider.loading}
    <p class="provider-label" role="status">Checking AI configuration…</p>
  {:else if provider.error}
    <div class="provider-retry">
      <p class="error" role="alert">{provider.error}</p>
      <button
        type="button"
        class="secondary"
        onclick={() => void provider.load()}>Retry AI setup</button
      >
    </div>
  {:else if provider.provider === "none"}
    <div class="setup-note">
      To enable AI, copy <code>.env.example</code> to <code>.env</code>, add a
      provider key, and restart the API. The counter works without one.
    </div>
  {:else}
    <p class="provider-label">{provider.provider} / {provider.model}</p>
  {/if}
  <!-- Scrollable history must remain keyboard accessible. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    bind:this={transcript}
    onscroll={trackScroll}
    class="transcript"
    role="region"
    aria-label="Conversation"
    aria-busy={busy}
    tabindex="0"
  >
    {#if chat.messages.length === 0}<div class="empty-chat">
        <span aria-hidden="true">✳</span>
        <p>A little state goes a long way.</p>
        <small>Your next idea starts here.</small>
      </div>{/if}
    {#each chat.messages as message (message.id)}<article
        class={["message", message.role]}
      >
        <div class="role">{message.role === "user" ? "You" : "Assistant"}</div>
        <p>
          {message.content ||
            (busy &&
            message.role === "assistant" &&
            message.id === chat.messages.at(-1)?.id
              ? "Thinking…"
              : "No reply text was generated.")}
        </p>
      </article>{/each}
  </div>
  {#if newContent}<button
      type="button"
      class="secondary latest-reply"
      onclick={showLatest}>Latest reply ↓</button
    >{/if}
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
      bind:this={draftInput}
      onkeydown={onDraftKey}
      aria-describedby="chat-input-help"
      bind:value={chat.draft}
      maxlength={MAX_CHAT_MESSAGE_LENGTH}
      placeholder="What would you like to build?"
      rows="2"></textarea>
    <p id="chat-input-help" class="input-help">
      <span>⌘ / Ctrl + Enter to send</span><span
        >{chat.draft.length.toLocaleString()} / {MAX_CHAT_MESSAGE_LENGTH.toLocaleString()}</span
      >
    </p>
    <div class="row">
      <button type="submit" disabled={!canSend}>Send message ↗</button
      >{#if busy}<button
          type="button"
          class="secondary"
          disabled={chat.turn !== "thinking"}
          onclick={() => void chat.stop()}>Stop</button
        >{/if}<button
        type="button"
        class="text-button"
        onclick={() => void newChat()}>New chat</button
      >
    </div>
  </form>
  <div class="card-footnote">
    <code>actors/chat.ts</code><span>Queue + bounded history + AI</span>
  </div>
</section>

<style>
  .input-help {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    margin: 8px 0 12px;
    font-size: 12px;
    color: #526747;
  }
  .provider-retry {
    display: grid;
    gap: 10px;
    justify-items: start;
    margin: 14px 0;
  }
  .latest-reply {
    margin: 10px 0 0;
    font-size: 12px;
    padding: 7px 12px;
  }
</style>
