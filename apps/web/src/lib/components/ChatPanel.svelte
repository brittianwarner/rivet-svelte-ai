<script lang="ts">
  import type { ChatViewModel } from "$lib/view-models/chat-view-model.svelte";

  let { chat }: { chat: ChatViewModel } = $props();

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void chat.send();
  }
</script>

<section>
  <h2>Chat</h2>
  <p class="meta">Socket {chat.connStatus}. Turn {chat.turn}.</p>
  {#if chat.connStatus === "reconnecting" || chat.connStatus === "disconnected"}
    <p class="status">Reconnecting. The reply continues on the actor.</p>
  {/if}
  {#if chat.error}
    <p class="error">{chat.error}</p>
  {/if}

  <div class="transcript">
    {#if chat.messages.length === 0}
      <p class="status">Type a message. The transcript stays on the conversation actor.</p>
    {/if}
    {#each chat.messages as message (message.id)}
      <article class={["message", message.role]}>
        <div class="role">{message.role}</div>
        <p>{message.content}</p>
      </article>
    {/each}
  </div>

  <form onsubmit={onSubmit}>
    <label for="draft">Message</label>
    <textarea id="draft" bind:value={chat.draft} placeholder="Ask something short"></textarea>
    <div class="row">
      <button
        type="submit"
        disabled={!chat.connected || chat.sending || chat.draft.trim().length === 0}
      >
        Send
      </button>
      <button
        type="button"
        class="secondary"
        disabled={chat.turn !== "thinking"}
        onclick={() => void chat.stop()}
      >
        Stop
      </button>
      <button type="button" class="secondary" onclick={() => chat.newChat()}>New chat</button>
    </div>
  </form>
</section>
