<script lang="ts">
  import type { AuditEntry } from "@example/entities/contracts";
  import { ago, clock } from "#lib/data/index.js";

  let {
    entries,
    more = false,
    loading = false,
    onmore,
  }: {
    entries: AuditEntry[];
    /** Older entries exist past the end of the list. */
    more?: boolean;
    loading?: boolean;
    onmore?: () => void;
  } = $props();
</script>

{#if entries.length === 0}
  <p class="empty">No activity yet.</p>
{:else}
  <ol class="activity">
    {#each entries as entry (entry.id)}
      <li>
        <span class="summary">{entry.summary}</span>
        <span class="by"><code>{entry.by}</code> · {entry.action}</span>
        <time datetime={new Date(entry.at).toISOString()}
          >{ago(entry.at, clock.now)}</time
        >
      </li>
    {/each}
  </ol>
  {#if more && onmore}
    <button
      type="button"
      class="text-button more"
      disabled={loading}
      onclick={onmore}>{loading ? "Loading…" : "Show older"}</button
    >
  {/if}
{/if}

<style>
  .activity {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 16px;
    border-bottom: 1px solid var(--line);
    padding: 10px 0;
  }
  .summary {
    font-size: 14px;
  }
  .by {
    grid-row: 2;
    color: var(--muted);
    font-size: 12px;
  }
  code {
    font-family: var(--mono);
  }
  time {
    grid-row: 1 / span 2;
    align-self: center;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .more {
    justify-self: start;
    margin-top: 8px;
    font-size: 13px;
  }
  .empty {
    color: var(--muted);
    font-size: 14px;
  }
</style>
