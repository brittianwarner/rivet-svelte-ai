<script lang="ts">
  import { ago, clock } from "#lib/data/index.js";

  let {
    actorKey,
    revision,
    updatedAt,
    connStatus,
  }: {
    actorKey: string[];
    revision?: number;
    updatedAt?: number;
    connStatus: string;
  } = $props();

  const live = $derived(connStatus === "connected");
  const label = $derived(
    live
      ? "Live"
      : connStatus === "connecting" || connStatus === "idle"
        ? "Connecting"
        : "Offline",
  );
</script>

<dl class="meta">
  <div>
    <dt>Actor</dt>
    <dd><code>{JSON.stringify(actorKey)}</code></dd>
  </div>
  {#if revision !== undefined}
    <div>
      <dt>Revision</dt>
      <dd><code>{revision}</code></dd>
    </div>
  {/if}
  {#if updatedAt !== undefined}
    <div>
      <dt>Updated</dt>
      <dd>{ago(updatedAt, clock.now)}</dd>
    </div>
  {/if}
  <div>
    <dt class="sr-only">Connection</dt>
    <dd class="status" data-live={live}>
      <span aria-hidden="true"></span>{label}
    </dd>
  </div>
</dl>

<style>
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 20px;
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
  .meta div {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  dt {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  dd {
    margin: 0;
  }
  code {
    color: var(--ink);
    font-family: var(--mono);
    font-size: 12px;
  }
  .status {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .status span {
    width: 7px;
    height: 7px;
    border: 1px solid var(--muted);
  }
  .status[data-live="true"] {
    color: var(--green);
  }
  .status[data-live="true"] span {
    border-color: var(--green);
    background: var(--green);
  }
</style>
