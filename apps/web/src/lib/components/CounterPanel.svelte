<script lang="ts">
  import type { CounterViewModel } from "$lib/view-models/counter-view-model.svelte";

  let { counter }: { counter: CounterViewModel } = $props();
  let nameDraft = $state("demo");

  function applyName(): void {
    counter.useName(nameDraft);
    nameDraft = counter.name;
  }
</script>

<section>
  <h2>Counter</h2>
  <p class="meta">Socket {counter.connStatus}. Count {counter.count}.</p>
  {#if counter.error}
    <p class="error">{counter.error}</p>
  {/if}

  <label for="counter-name">Name</label>
  <div class="row">
    <input
      id="counter-name"
      type="text"
      bind:value={nameDraft}
      onblur={applyName}
      onkeydown={(event) => {
        if (event.key === "Enter") applyName();
      }}
    />
  </div>
  <div class="row">
    <button type="button" disabled={!counter.connected} onclick={() => void counter.increment()}>
      Increment on socket
    </button>
    <button
      type="button"
      class="secondary"
      disabled={counter.httpPending}
      onclick={() => void counter.incrementViaHttp()}
    >
      Increment through API
    </button>
  </div>
</section>
