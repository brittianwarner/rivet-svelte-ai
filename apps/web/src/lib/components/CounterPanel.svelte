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
  <p>Two tabs. One actor. Updates arrive over a shared WebSocket connection.</p>
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
  <form class="counter-form" onsubmit={applyName}>
    <label for="counter-name"
      >Actor key <span>Same key = same counter</span></label
    >
    <div class="input-row">
      <input
        id="counter-name"
        bind:value={nameDraft}
        pattern={"[a-z0-9][a-z0-9\\-]{0,63}"}
        maxlength="64"
        required
        spellcheck="false"
      /><button class="secondary" type="submit">Connect</button>
    </div>
  </form>
  <div class="card-footnote">
    <code>actors/counter.ts</code><span>State + actions + events</span>
  </div>
</section>
