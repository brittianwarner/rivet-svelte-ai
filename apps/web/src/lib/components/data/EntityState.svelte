<script lang="ts">
  import type { EntityView } from "#lib/data/index.js";
  import { resolve } from "$app/paths";

  let {
    view,
    noun,
    error,
    onretry,
  }: {
    view: EntityView;
    noun: string;
    error?: string | null;
    onretry?: () => void;
  } = $props();
</script>

{#if view === "loading"}
  <div class="state" role="status" aria-busy="true">
    <div class="skeleton wide"></div>
    <div class="skeleton"></div>
    <div class="skeleton"></div>
    <span class="sr-only">Loading the {noun}…</span>
  </div>
{:else if view !== "ready"}
  <div class="state" role="alert">
    <h2>
      {view === "missing"
        ? `No ${noun} has this id.`
        : view === "denied"
          ? `You do not have access to this ${noun}.`
          : `Could not load the ${noun}.`}
    </h2>
    <p>
      {view === "missing"
        ? "It may have been typed wrong, deleted, or never created."
        : view === "denied"
          ? "Ask an admin for an invitation, or switch to someone who is a member."
          : (error ?? "The connection failed. Rivet keeps retrying.")}
    </p>
    <div class="actions">
      {#if view === "error" && onretry}
        <button type="button" onclick={onretry}>Try again</button>
      {/if}
      <a class="button secondary-link" href={resolve("/data")}
        >Back to overview</a
      >
    </div>
  </div>
{/if}

<style>
  .state {
    display: grid;
    gap: 12px;
    max-width: 560px;
    padding: 32px 0;
  }
  h2 {
    font-size: 22px;
    line-height: 1.2;
  }
  p {
    color: var(--muted);
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
  .secondary-link {
    border-color: var(--line);
    background: transparent;
    color: var(--ink);
  }
  .skeleton {
    width: 40%;
    height: 16px;
    background: var(--surface);
  }
  .skeleton.wide {
    width: 70%;
    height: 32px;
  }
</style>
