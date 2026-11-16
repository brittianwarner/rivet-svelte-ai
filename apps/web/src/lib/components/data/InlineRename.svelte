<script lang="ts">
  import type { Attachment } from "svelte/attachments";

  let {
    value,
    label,
    editable,
    busy = false,
    onsave,
  }: {
    value: string;
    label: string;
    editable: boolean;
    busy?: boolean;
    onsave: (next: string) => Promise<unknown>;
  } = $props();

  let editing = $state(false);
  let draft = $state("");

  /** Select the text as soon as the field appears. */
  const selectOnMount: Attachment<HTMLInputElement> = (node) => {
    node.select();
  };

  function start() {
    draft = value;
    editing = true;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (!next || next === value) {
      editing = false;
      return;
    }
    const result = await onsave(next);
    if (result) editing = false;
  }
</script>

{#if editing}
  <form class="rename" onsubmit={submit}>
    <input
      {@attach selectOnMount}
      bind:value={draft}
      aria-label={label}
      maxlength="64"
      onkeydown={(event) => {
        if (event.key === "Escape") editing = false;
      }}
    />
    <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    <button type="button" class="secondary" onclick={() => (editing = false)}
      >Cancel</button
    >
  </form>
{:else}
  <div class="title">
    <h1>{value}</h1>
    {#if editable}
      <button type="button" class="text-button" onclick={start}>Rename</button>
    {/if}
  </div>
{/if}

<style>
  .title {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    align-items: baseline;
  }
  h1 {
    font-size: clamp(28px, 4vw, 40px);
    line-height: 1.1;
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }
  .rename {
    display: flex;
    gap: 8px;
    max-width: 560px;
  }
  .rename input {
    font-size: 20px;
  }
</style>
