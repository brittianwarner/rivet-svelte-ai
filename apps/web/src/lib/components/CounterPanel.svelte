<script lang="ts">
  import type { CounterViewModel } from "#lib/view-models/counter-view-model.svelte.js";
  let { counter }: { counter: CounterViewModel } = $props();
  let nameDraft = $state("demo");
  function applyName(event: SubmitEvent): void {
    event.preventDefault();
    counter.useName(nameDraft);
    nameDraft = counter.name;
  }
</script>

<section class="demo-card counter-card" aria-labelledby="counter-title">
  <div class="card-heading">
    <span class="eyebrow">01 / SHARED STATE</span><span class="connection-badge"
      ><span class:online={counter.connected} class="status-dot"
      ></span>{counter.connStatus}</span
    >
  </div>
  <h3 id="counter-title">The realtime counter.</h3>
  <p>Two tabs. One actor. Updates arrive as WebSocket events.</p>
  <div class="counter-body">
    <div class="counter-state">
      <div class="counter-value" aria-live="polite" aria-label="Counter value">
        {counter.count.toLocaleString()}
      </div>
      <div class="counter-actions">
        <button
          disabled={!counter.connected}
          onclick={() => void counter.increment()}>+ Increment</button
        ><button
          class="secondary"
          disabled={!counter.connected || counter.httpPending}
          onclick={() => void counter.incrementViaHttp()}
          >{counter.httpPending ? "Sending…" : "+ Via HTTP"}</button
        >
      </div>
      {#if counter.error}<p class="error" role="alert">{counter.error}</p>{/if}
    </div>
    <form class="counter-form" onsubmit={applyName}>
      <label for="counter-name"
        >Actor key <span>Same key = same counter</span></label
      >
      <div class="input-row">
        <input
          id="counter-name"
          bind:value={nameDraft}
          pattern={"[a-zA-Z0-9][a-zA-Z0-9\\-]{0,63}"}
          maxlength="64"
          required
          title="Use 1–64 letters, numbers, or hyphens. Start with a letter or number. Keys are converted to lowercase."
          aria-describedby="counter-key-help"
          spellcheck="false"
        /><button class="secondary" type="submit">Connect</button>
      </div>
      <p id="counter-key-help" class="input-hint">
        1–64 letters, numbers, or hyphens. Start with a letter or number. Keys
        become lowercase.
      </p>
    </form>
  </div>
  <div class="card-footnote">
    <code>actors/counter.ts</code><span>State + actions + events</span>
  </div>
</section>

<style>
  .counter-body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 40px;
    align-items: center;
  }
  .counter-form {
    margin: 0;
  }
  @media (max-width: 640px) {
    .counter-body {
      grid-template-columns: 1fr;
      gap: 22px;
    }
    .counter-form {
      margin-bottom: 14px;
    }
  }
  .input-hint {
    font-size: 12px;
    line-height: 1.6;
    color: #526747;
    margin-top: 9px;
  }
</style>
