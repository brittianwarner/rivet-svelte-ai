<script lang="ts">
  import { resolve } from "$app/paths";
  import { getPrincipal } from "#lib/data/index.js";
  import Avatar from "./Avatar.svelte";

  const principal = getPrincipal();
</script>

<main class="sign-in" id="main">
  <a class="back" href={resolve("/")}>← rivet + svelte</a>
  <div class="panel">
    <p class="eyebrow">DATA / SIGN IN</p>
    <h1>Browse the service as one person.</h1>
    <p class="lede">
      Every organization, member, and project lives in its own actor. Pick a
      person: the API signs a token for them, and each actor checks it before it
      shares anything.
    </p>
    {#if principal.loading && principal.personas.length === 0}
      <p class="muted" role="status">Loading people…</p>
    {:else}
      <ul class="personas">
        {#each principal.personas as persona (persona.sub)}
          <li>
            <button
              type="button"
              class="persona"
              disabled={principal.pending !== null}
              onclick={() => void principal.signIn(persona.sub)}
            >
              <Avatar id={persona.sub} name={persona.name} size={36} />
              <span class="who">
                <strong>{persona.name}</strong>
                <code>["user","{persona.sub}"]</code>
              </span>
              <span aria-hidden="true">
                {principal.pending === persona.sub ? "…" : "→"}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if principal.error}
      <p class="error" role="alert">{principal.error}</p>
    {/if}
    <p class="muted small">
      Open a second tab as someone else to watch changes arrive live.
    </p>
  </div>
</main>

<style>
  .sign-in {
    display: grid;
    align-content: start;
    gap: 48px;
    min-height: 100vh;
    padding: 32px clamp(16px, 5vw, 64px);
  }
  .back {
    color: var(--muted);
    font-size: 13px;
  }
  .panel {
    display: grid;
    gap: 16px;
    width: min(100%, 520px);
  }
  h1 {
    font-size: clamp(30px, 5vw, 44px);
    line-height: 1.05;
    letter-spacing: -0.03em;
  }
  .lede {
    color: var(--muted);
  }
  .personas {
    display: grid;
    gap: 8px;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }
  .persona {
    justify-content: flex-start;
    width: 100%;
    min-height: 64px;
    gap: 14px;
    border-color: var(--line);
    background: var(--paper);
    color: var(--ink);
    text-align: left;
  }
  .persona:hover:not(:disabled) {
    border-color: var(--ink);
    background: var(--surface);
    color: var(--ink);
  }
  .who {
    display: grid;
    flex: 1;
  }
  .who strong {
    font-size: 15px;
  }
  .who code {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 13px;
  }
</style>
