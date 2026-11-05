<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { SESSION_ACTOR_LIMIT } from "@example/wire";
  import { actorExamples } from "#lib/visuals/actor-examples.js";
  import type { SessionViewModel } from "#lib/view-models/session-view-model.svelte.js";
  import type {
    ActorNode,
    SceneLabel,
    createActorScene,
  } from "#lib/visuals/actor-scene.js";

  let { session }: { session: SessionViewModel } = $props();
  let canvas: HTMLCanvasElement;
  let reconnectButton = $state.raw<HTMLButtonElement | undefined>(undefined);
  let scene = $state.raw<ReturnType<typeof createActorScene> | null>(null);
  let markers = $state.raw<SceneLabel[]>([]);
  let visualState = $state<"loading" | "ready" | "fallback">("loading");
  let paused = $state(false);
  let sending = $state(false);
  let removalStatus = $state("");
  let removed = $state<{ key: string; label: string } | null>(null);
  let canvasAddButton = $state.raw<HTMLButtonElement | undefined>(undefined);
  let canvasRemoveButton = $state.raw<HTMLButtonElement | undefined>(undefined);
  let keyDraft = $derived(session.selectedKey);
  let activity = $state(
    "Select an actor, then send an action to watch its state update.",
  );
  let codeTab = $state<"state" | "svelte" | "view-model" | "session">("state");
  let alive = true;
  const nodes: ActorNode[] = $derived(
    session.actors.map((entry) => ({
      id: `counter/${entry.key}`,
      label: entry.label,
      kind: "counter",
      connected: entry.model.connected,
      value: entry.model.count,
    })),
  );
  const selectedId = $derived(
    session.selectedKey ? `counter/${session.selectedKey}` : "",
  );
  const selected = $derived(
    nodes.find((node) => node.id === selectedId) ?? nodes[0],
  );
  const entry = $derived(
    session.actors.find((item) => item.key === session.selectedKey) ??
      session.actors[0],
  );
  const model = $derived(entry?.model ?? null);
  const connected = $derived(session.connectedActors);
  function actorNumber(label: string): string {
    return label.replace(/^counter-/, "");
  }
  const examples = $derived(actorExamples("counter", entry?.key ?? "your-key"));
  const code = $derived(
    codeTab === "session"
      ? JSON.stringify(
          {
            actors: session.actors.map((item) => ({
              key: item.key,
              label: item.label,
            })),
            revision: session.revision,
          },
          null,
          2,
        )
      : codeTab === "state"
        ? model
          ? `{\n  "count": ${model.count}\n}`
          : session.loading
            ? "// Restoring your session…"
            : "// Add an actor to inspect its state."
        : codeTab === "svelte"
          ? examples.component
          : examples.viewModel,
  );
  const sessionError = $derived(session.error ?? session.connectionError);

  $effect(() => {
    scene?.update(nodes, selectedId);
  });
  $effect(() => {
    scene?.setPaused(paused);
  });
  onMount(() => {
    let cancelled = false;
    let instance: ReturnType<typeof createActorScene> | null = null;
    void import("#lib/visuals/actor-scene.js")
      .then(({ createActorScene }) => {
        if (cancelled) return;
        try {
          instance = createActorScene(canvas, selectActor, (next) => {
            markers = next;
          });
          scene = instance;
          visualState = "ready";
        } catch {
          visualState = "fallback";
        }
      })
      .catch(() => {
        if (!cancelled) visualState = "fallback";
      });
    return () => {
      cancelled = true;
      instance?.dispose();
    };
  });
  onDestroy(() => {
    alive = false;
  });
  function selectActor(id: string): void {
    const key = id.startsWith("counter/") ? id.slice(8) : id;
    session.select(key);
    keyDraft = key;
  }
  async function addActor(): Promise<void> {
    activity = "Creating your counter…";
    await session.createCounter();
    if (alive)
      activity =
        session.error ??
        "Actor added. Reload the page to find your counters here again.";
  }
  async function removeActor(): Promise<void> {
    if (!entry || !session.canMutate || sending) return;
    const target = { key: entry.key, label: entry.label };

    await session.removeCounter(target.key);
    if (!alive) return;
    if (session.error) {
      activity = session.error;
      return;
    }
    removed = target;
    removalStatus = `${target.label} removed. Undo is available in the canvas controls.`;
    activity =
      "Select an actor, then send an action to watch its state update.";
    await tick();
    canvasAddButton?.focus({ preventScroll: true });
  }
  async function undoRemove(): Promise<void> {
    if (!removed || !session.canMutate) return;
    const target = removed;
    await session.attachCounter(target.key, target.label);
    if (!alive) return;
    if (session.error) {
      activity = session.error;
      return;
    }
    removed = null;
    removalStatus = `${target.label} restored.`;
    await tick();
    (canvasAddButton?.disabled ? canvasRemoveButton : canvasAddButton)?.focus({
      preventScroll: true,
    });
  }
  async function disconnect(): Promise<void> {
    if (!entry) return;
    session.disconnect(entry.key);
    activity = `${entry.label} disconnected locally. Your session still remembers it.`;
    await tick();
    reconnectButton?.focus();
  }
  function reconnect(): void {
    if (entry) {
      session.reconnect(entry.key);
      activity = `Reconnecting ${entry.label} to its existing state…`;
    }
  }
  async function send(viaHttp = false): Promise<void> {
    if (!model || sending || !model.connected || !selected) return;
    const target = model,
      connection = target.actor,
      actorKey = target.name,
      name = selected.label;
    sending = true;
    activity = `${name}.increment(1) → ${viaHttp ? "HTTP" : "WebSocket"}`;
    scene?.action(selected.id);
    try {
      if (viaHttp) await target.incrementViaHttp();
      else await target.increment();
      if (!alive) return;
      if (target.actor !== connection || target.name !== actorKey) {
        activity = `${name}: connection changed before the response. Reconnect to check its state.`;
        return;
      }
      activity =
        target.error ??
        `${name} → count: ${target.count} → newCount event → Svelte updated.`;
    } catch {
      if (alive)
        activity =
          "The action could not be completed. Check the connection and try again.";
    } finally {
      if (alive) sending = false;
    }
  }
  async function connectKey(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await session.attachCounter(keyDraft);
    if (alive)
      activity =
        session.error ?? "Counter connected and saved to your session.";
  }
</script>

<section class="actor-playground" aria-label="Live actor anatomy">
  <div class="playground-toolbar">
    <div class="toolbar-heading">
      <span class="kicker">LIVE PLAYGROUND</span>
      <h3>See your actors in action.</h3>
    </div>
    <div class="toolbar-actions">
      <div class="connected-count" aria-live="polite" aria-atomic="true">
        <span class:online={connected > 0} class="connection-light"
        ></span><strong aria-label="Connected actors">{connected}</strong><span
          >{connected === 1 ? "counter connected" : "counters connected"}</span
        >
      </div>
    </div>
  </div>

  <div class="session-status" data-session-id={session.id}>
    <span class:online={session.connected} class="connection-light"></span>
    <span
      >{session.loading
        ? "Restoring session…"
        : session.pending
          ? "Saving your actors…"
          : session.connected
            ? "Session connected"
            : "Session reconnecting…"}</span
    >
    <code title={session.id}
      >session / {session.id ? session.id.slice(0, 8) : "connecting"}</code
    >
    <span class="session-members"
      ><strong aria-label="Session actors">{session.actors.length}</strong> / {SESSION_ACTOR_LIMIT}
      saved counters</span
    >
    {#if session.temporary}<span class="temporary-session"
        >Temporary identity · browser storage unavailable</span
      >{/if}
  </div>
  {#if sessionError}<div class="session-error">
      <p role="alert">{sessionError}</p>
      <button
        class="http-action"
        disabled={session.pending}
        onclick={() => void session.retry()}>Retry session</button
      >
    </div>{/if}
  <div class="runtime-grid">
    <div class="actor-field">
      <div class="field-heading">
        <span>RIVET ACTORS</span><span>SELECT AN ACTOR</span>
      </div>
      <div class="scene-viewport" data-render-state={visualState}>
        <canvas
          bind:this={canvas}
          aria-label="Interactive 3D actor field. Numbered nodes correspond to actors in the list below."
        ></canvas>
        {#if visualState === "ready"}
          <div class="scene-markers" aria-label="Labeled system diagram">
            {#each markers.filter((marker) => marker.kind === "counter") as marker (marker.id)}
              <button
                class="actor-marker"
                class:marker-selected={selectedId === marker.id}
                aria-label={`Inspect actor ${marker.label}`}
                aria-pressed={selectedId === marker.id}
                style:left={`${marker.x}px`}
                style:top={`${marker.y}px`}
                onclick={() => {
                  selectActor(marker.id);
                }}
                ><span class="marker-number">{actorNumber(marker.label)}</span
                ></button
              >
            {/each}
          </div>
        {:else}
          <div class="scene-message">
            <span class="fallback-symbol" aria-hidden="true">◈</span><strong
              >{visualState === "loading"
                ? "Loading the 3D view…"
                : "3D view unavailable."}</strong
            >
            <p>
              {visualState === "loading"
                ? "Your actors will appear here."
                : "3D is unavailable in this browser. Select an actor below and use the live client."}
            </p>
          </div>
        {/if}
      </div>
      <div class="canvas-actions" aria-label="Canvas actor controls">
        <div class="canvas-primary">
          <button
            class="canvas-add"
            aria-label="Add actor"
            title={session.actors.length >= SESSION_ACTOR_LIMIT
              ? "Seven actors saved. Remove one to make room."
              : "Create a counter in this session"}
            bind:this={canvasAddButton}
            disabled={!session.canMutate ||
              session.actors.length >= SESSION_ACTOR_LIMIT}
            onclick={addActor}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg
            >
            Add actor
          </button>
          {#if removed}
            <button
              class="undo-remove"
              aria-label="Undo remove"
              title={`Restore ${removed.label}`}
              disabled={!session.canMutate ||
                session.actors.length >= SESSION_ACTOR_LIMIT}
              onclick={undoRemove}>Undo</button
            >
          {/if}
        </div>
        {#if entry}
          <div class="canvas-selection">
            <span title={`Selected actor: ${entry.label}`}>{entry.label}</span>
            <button
              class="canvas-remove"
              aria-label={`Remove ${entry.label} from playground`}
              bind:this={canvasRemoveButton}
              title={`Remove ${entry.label} from playground`}
              disabled={!session.canMutate || sending}
              onclick={removeActor}
            >
              <svg
                aria-hidden="true"
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><path
                  d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"
                /></svg
              >
            </button>
          </div>
        {/if}
      </div>
      <span class="sr-only" role="status">{removalStatus}</span>
      <div class="field-controls">
        <div class="message-legend">
          <span><i></i> Action</span><span
            ><i class="event-color"></i> Event</span
          ><span class="gateway-legend"
            ><span aria-hidden="true">◆</span> Rivet gateway</span
          >
        </div>
        <div class="camera-controls" aria-label="3D view controls">
          <button
            onclick={() => scene?.rotate()}
            disabled={visualState !== "ready"}
            aria-label="Rotate view">↻</button
          ><button
            onclick={() => scene?.reset()}
            disabled={visualState !== "ready"}>Reset</button
          ><button
            aria-pressed={paused}
            onclick={() => {
              paused = !paused;
            }}>{paused ? "Play motion" : "Pause motion"}</button
          >
        </div>
      </div>
    </div>

    <section class="svelte-client" aria-label="Svelte client">
      <div class="client-chrome">
        <span class="window-dots" aria-hidden="true"><i></i><i></i><i></i></span
        ><span>SVELTE CLIENT</span><span
          class="client-live"
          class:is-connected={model?.connected}
          >{!model
            ? session.loading
              ? "RESTORING"
              : "READY"
            : !model.actor
              ? "DISCONNECTED"
              : model.connected
                ? "LIVE"
                : "CONNECTING"}</span
        >
      </div>
      {#if selected && model && entry}<div class="client-content">
          <div class="client-actor">
            <span class="actor-index">{actorNumber(entry.label)}</span>
            <div>
              <span class="client-label">CONNECTED TO</span>
              <h4 title={selected.label}>{selected.label}</h4>
            </div>
            <span class:online={model.connected} class="connection-light"
            ></span>
          </div>
          <div class="client-state">
            <span class="client-label">COUNT</span><output
              aria-label="Counter value"
              aria-live="polite">{model.count.toLocaleString()}</output
            >
            <p>Rivet stores this count. Svelte updates when it changes.</p>
          </div>
          <div class="client-buttons">
            <button
              class="increment-action"
              disabled={!model.connected ||
                sending ||
                session.pending ||
                session.loading}
              onclick={() => void send()}>+ Increment</button
            ><button
              class="http-action"
              disabled={!model.connected ||
                sending ||
                model.httpPending ||
                session.pending ||
                session.loading}
              onclick={() => void send(true)}>+ Via HTTP</button
            >
          </div>
          {#if model.error}<p class="client-error" role="alert">
              {model.error}
            </p>{/if}
          <form class="key-form" onsubmit={connectKey}>
            <label for="playground-actor-key">Actor key</label>
            <div>
              <input
                id="playground-actor-key"
                bind:value={keyDraft}
                required
                maxlength="64"
                pattern={"[a-zA-Z0-9][a-zA-Z0-9\\-]{0,63}"}
                spellcheck="false"
                aria-describedby="playground-key-help"
                title="Use 1–64 letters, numbers, or hyphens. Start with a letter or number. Keys become lowercase."
                disabled={session.pending || session.loading}
              /><button type="submit" disabled={!session.canMutate}
                >Connect</button
              >
            </div>
            <p id="playground-key-help">
              Use 1–64 letters, numbers, or hyphens. Start with a letter or
              number. Connecting a key keeps existing session actors.
            </p>
          </form>
          <div class="client-footer">
            {#if model.actor}<button
                class="disconnect-action"
                onclick={disconnect}
                >Disconnect actor <span aria-hidden="true">↗</span></button
              >{:else}<button
                class="http-action reconnect-action"
                bind:this={reconnectButton}
                onclick={reconnect}>Reconnect actor</button
              >{/if}
          </div>
        </div>{:else}<div class="client-loading">
          <span class="fallback-symbol" aria-hidden="true">◈</span><strong
            >{sessionError
              ? "Your session needs attention."
              : session.loading
                ? "Restoring your actors…"
                : "Your canvas is ready."}</strong
          >
          <p>
            {session.loading
              ? "Your session remembers your counters in Rivet. This browser stores only the session ID."
              : "Use + Add actor in the canvas to create a counter with its own state."}
          </p>
        </div>{/if}
    </section>
  </div>

  <div class="actor-dock" aria-label="Playground actors">
    {#each nodes as node (node.id)}<button
        class="actor-chip"
        class:chip-selected={selectedId === node.id}
        aria-pressed={selectedId === node.id}
        onclick={() => {
          selectActor(node.id);
        }}
        ><span class="chip-index">{actorNumber(node.label)}</span><span
          class="chip-name"
          title={node.label}>{node.label}</span
        ><span class:online={node.connected} class="connection-light"
        ></span></button
      >{/each}
    <span class="connection-budget"
      >{session.actors.length}/{SESSION_ACTOR_LIMIT} saved counters</span
    >
  </div>
  <div class="activity-line" role="status">
    <span aria-hidden="true">↳</span><span>{activity}</span>
  </div>

  <div class="code-workspace">
    <div class="code-toolbar">
      <div role="group" aria-label="Code view">
        <button
          class:tab-active={codeTab === "state"}
          aria-pressed={codeTab === "state"}
          onclick={() => {
            codeTab = "state";
          }}>Live state</button
        ><button
          class:tab-active={codeTab === "svelte"}
          aria-label="Svelte connection"
          aria-pressed={codeTab === "svelte"}
          onclick={() => {
            codeTab = "svelte";
          }}>Svelte component</button
        ><button
          class:tab-active={codeTab === "view-model"}
          aria-pressed={codeTab === "view-model"}
          onclick={() => {
            codeTab = "view-model";
          }}>View model</button
        ><button
          class:tab-active={codeTab === "session"}
          aria-pressed={codeTab === "session"}
          onclick={() => {
            codeTab = "session";
          }}>Session state</button
        >
      </div>
      <span
        >{codeTab === "state" || codeTab === "session"
          ? "JSON"
          : "TYPESCRIPT"}</span
      >
    </div>
    <!-- Code examples scroll and must remain keyboard accessible. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <pre
      tabindex="0"
      aria-label={codeTab === "session"
        ? "Session registry state"
        : codeTab === "state"
          ? "Selected actor state"
          : codeTab === "svelte"
            ? "Actor connection example"
            : "Actor view model example"}><code>{code}</code></pre>
  </div>
  <div class="playground-footnote">
    <span
      >Each orb is a counter actor. The gateway routes actions; events update
      connected clients. Your session remembers up to seven counters in this
      demo, even after you disconnect.</span
    ><a
      href="https://github.com/brittianwarner/rivet-svelte-ai/blob/main/docs/first-actor.md"
      >Build your first actor ↗</a
    >
  </div>
</section>

<style>
  .actor-playground {
    --ink: #f4f3ef;
    --muted: #a3a9b3;
    --line: #262c36;
    --orange: #ff744b;
    --mint: #82e4ba;
    background: #0e1118;
    border: 1px solid #2b303a;
    border-radius: 14px;
    overflow: hidden;
    color: var(--ink);
  }
  button,
  input {
    font: inherit;
  }
  button {
    cursor: pointer;
    transition:
      background 0.16s,
      color 0.16s,
      border-color 0.16s;
  }
  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  button:focus-visible,
  input:focus-visible,
  pre:focus-visible {
    outline: 2px solid var(--mint);
    outline-offset: 4px;
  }
  .playground-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 24px;
    padding: 26px 28px;
    border-bottom: 1px solid var(--line);
  }
  .kicker {
    display: block;
    color: var(--orange);
    font: 11px var(--mono);
    letter-spacing: 0.13em;
    margin-bottom: 9px;
  }
  .toolbar-heading h3 {
    color: var(--ink);
    font:
      500 24px/1.2 "Space Grotesk",
      sans-serif;
    letter-spacing: -0.04em;
    margin: 0;
  }
  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: 24px;
  }
  .connected-count {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .connected-count strong {
    color: var(--ink);
    font:
      22px "Space Grotesk",
      sans-serif;
  }
  .connection-light {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #626975;
    flex-shrink: 0;
  }
  .connection-light.online {
    background: var(--mint);
    box-shadow: 0 0 0 3px #82e4ba0d;
  }
  .runtime-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.9fr) minmax(300px, 1fr);
    min-height: 540px;
    height: auto;
  }
  .actor-field {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: radial-gradient(ellipse at 35% 45%, #17202a, #0d1118 72%);
  }
  .field-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 20px 24px 0;
    color: #939daa;
    font: 10px var(--mono);
    letter-spacing: 0.09em;
  }
  .field-heading > span:last-child {
    color: #687582;
    font-size: 9px;
  }
  .scene-viewport {
    position: relative;
    flex: 1;
    min-height: 360px;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    cursor: grab;
  }
  canvas:active {
    cursor: grabbing;
  }
  .scene-markers {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .actor-marker {
    position: absolute;
    transform: translate(-50%, -50%);
    width: 44px;
    height: 44px;
    min-height: 44px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: none;
    pointer-events: auto;
  }
  .marker-number {
    display: grid;
    place-items: center;
    width: 27px;
    height: 27px;
    border: 1px solid #6c7e88;
    border-radius: 50%;
    background: #131a23;
    color: #d2e3dc;
    font: 12px var(--mono);
    box-shadow: 0 3px 12px #0005;
  }
  .actor-marker:hover {
    background: none;
  }
  .actor-marker:hover .marker-number {
    border-color: var(--mint);
    color: var(--mint);
  }
  .marker-selected .marker-number {
    background: var(--orange);
    border-color: var(--orange);
    color: #1b100b;
    box-shadow: 0 0 0 4px #ff744b15;
  }
  .scene-message {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 12px;
    padding: 35px;
    text-align: center;
  }
  .fallback-symbol {
    color: var(--mint);
    font-size: 42px;
  }
  .scene-message strong {
    font-size: 16px;
    font-weight: 500;
  }
  .scene-message p {
    font-size: 13px;
    line-height: 1.65;
    color: var(--muted);
    max-width: 300px;
  }
  .canvas-actions {
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: center;
    max-width: calc(100% - 24px);
    gap: 12px;
    margin: 8px 12px 14px;
    padding: 5px;
    background: #151c25;
    border: 1px solid #2c3743;
    border-radius: 12px;
    box-shadow: 0 6px 24px #0003;
  }
  .canvas-primary,
  .canvas-selection {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }
  .canvas-actions button {
    min-height: 44px;
    border-radius: 8px;
    padding: 0 12px;
    font-size: 12px;
    white-space: nowrap;
    gap: 7px;
  }
  .canvas-add {
    color: #1d130e;
    background: var(--orange);
    border: 1px solid transparent;
    font-weight: 600;
  }
  .canvas-add:hover:not(:disabled) {
    background: #ff906e;
  }
  .canvas-selection {
    border-left: 1px solid #34404c;
    padding-left: 12px;
  }
  .canvas-selection > span {
    color: #d6dee6;
    font: 11px var(--mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .canvas-actions .canvas-remove {
    min-width: 44px;
    padding: 0;
    color: #a8b5c1;
    background: transparent;
    border: 1px solid transparent;
  }
  .canvas-actions .canvas-remove:hover:not(:disabled) {
    background: #42271f;
    color: #ffb69e;
  }
  .canvas-actions .undo-remove {
    color: #bac8d4;
    background: transparent;
    border: 1px solid transparent;
    padding: 0 9px;
  }
  .canvas-actions .undo-remove:hover:not(:disabled) {
    background: #25313f;
    color: var(--ink);
  }
  @media (max-width: 420px) {
    .canvas-actions {
      gap: 8px;
    }
    .canvas-selection {
      padding-left: 8px;
    }
    .canvas-actions button {
      padding-inline: 9px;
    }
  }
  .activity-line {
    flex-wrap: wrap;
  }
  .field-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    padding: 7px 18px;
    gap: 6px 14px;
    border-top: 1px solid #1f2833;
  }
  .message-legend {
    display: flex;
    gap: 16px;
    font: 12px var(--mono);
    color: #a3b1bf;
  }
  .message-legend > span {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .message-legend i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--orange);
  }
  .message-legend .event-color {
    background: var(--mint);
  }
  .gateway-legend {
    color: #b0bdc9;
  }
  .gateway-legend > span {
    color: var(--orange);
    font-size: 12px;
  }
  .camera-controls {
    display: flex;
    gap: 2px;
  }
  .camera-controls button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    min-width: 44px;
    padding: 7px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: #a2adb9;
    font-size: 13px;
    gap: 0;
    font-weight: 450;
  }
  .camera-controls button:nth-child(2) {
    min-width: 58px;
  }
  .camera-controls button:last-child {
    min-width: 100px;
  }
  .camera-controls button:hover:not(:disabled) {
    background: #1c2631;
    color: var(--ink);
    border-color: #34404b;
  }
  .svelte-client {
    min-width: 0;
    border-left: 1px solid #303540;
    background: #12161f;
  }
  .client-chrome {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 42px;
    padding: 0 20px;
    border-bottom: 1px solid #272e39;
    background: #191e28;
    color: #bac0ca;
    font: 11px var(--mono);
  }
  .window-dots {
    display: flex;
    gap: 4px;
  }
  .window-dots i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #59616e;
  }
  .client-live {
    margin-left: auto;
    color: #87919f;
    font-size: 9px;
    letter-spacing: 0.1em;
  }
  .client-live.is-connected {
    color: var(--mint);
  }
  .client-content {
    display: flex;
    flex-direction: column;
    min-height: 498px;
    height: auto;
    padding: 22px 24px 16px;
  }
  .client-actor {
    display: flex;
    align-items: center;
    gap: 11px;
  }
  .actor-index {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    background: #252725;
    color: var(--orange);
    border: 1px solid #49372e;
    border-radius: 7px;
    font: 11px var(--mono);
    flex-shrink: 0;
  }
  .client-actor > div {
    min-width: 0;
    flex: 1;
  }
  .client-label {
    font: 10px var(--mono);
    letter-spacing: 0.11em;
    color: #939eab;
  }
  .client-actor h4 {
    color: var(--ink);
    font-size: 19px;
    font-weight: 500;
    line-height: 1.4;
    margin: 2px 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .client-state {
    padding: 27px 0 24px;
  }
  .client-state output {
    display: block;
    color: var(--ink);
    font:
      500 clamp(64px, 6vw, 86px)/1.1 "Space Grotesk",
      sans-serif;
    letter-spacing: -0.065em;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .client-state p {
    color: #8996a3;
    font-size: 13px;
    margin: 10px 0 0;
  }
  .client-buttons {
    display: flex;
    gap: 8px;
  }
  .client-buttons button {
    min-height: 44px;
    padding: 10px 12px;
    border-radius: 6px;
    gap: 0;
    white-space: nowrap;
    font-size: 14px;
    font-weight: 600;
  }
  .increment-action {
    flex: 1;
    background: var(--orange);
    border: 1px solid var(--orange);
    color: #20100a;
  }
  .increment-action:hover:not(:disabled) {
    background: #ff8e6b;
    border-color: #ff8e6b;
  }
  .http-action {
    background: #1c242e;
    border: 1px solid #36414d;
    color: #c6d5d4;
  }
  .http-action:hover:not(:disabled) {
    background: #273540;
    color: var(--ink);
  }
  .client-error {
    font-size: 12px;
    color: #ffb69f;
    line-height: 1.5;
    margin: 10px 0 0;
  }
  .key-form {
    margin-top: 24px;
  }
  .key-form > label {
    display: block;
    color: #a3aebb;
    font-size: 12px;
    margin-bottom: 8px;
  }
  .key-form > div {
    display: flex;
    gap: 7px;
  }
  .key-form input {
    width: 100%;
    min-width: 0;
    padding: 9px 10px;
    background: #0d121a;
    border: 1px solid #303b48;
    border-radius: 5px;
    color: #e0e6e8;
    font: 13px var(--mono);
  }
  .key-form button {
    min-height: 44px;
    padding: 8px 11px;
    background: #222d37;
    color: #d1e0de;
    border: 1px solid #3c4b57;
    border-radius: 5px;
    font-size: 11px;
    gap: 0;
  }
  .key-form button:hover {
    background: #2d3d48;
    color: var(--ink);
  }
  .key-form p {
    color: #a3a9b3;
    font-size: 13px;
    line-height: 1.6;
    margin: 8px 0 0;
  }
  .client-footer {
    margin-top: auto;
    min-height: 38px;
    padding-top: 14px;
    border-top: 1px solid #29323c;
  }
  .disconnect-action {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: none;
    color: #a7b4c1;
    font-size: 11px;
    min-height: 44px;
    font-weight: 450;
  }
  .disconnect-action:hover {
    background: none;
    color: #ffb69f;
  }
  .actor-dock {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
    padding: 17px 24px;
    border-top: 1px solid #2b323d;
    background: #10151d;
    min-width: 0;
  }
  .actor-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    min-height: 44px;
    padding: 8px 10px;
    border: 1px solid #303b46;
    border-radius: 5px;
    background: #17202a;
    color: #a7b6c2;
    font-size: 11px;
    font-weight: 450;
  }
  .actor-chip:hover {
    background: #21303a;
    border-color: #526579;
    color: var(--ink);
  }
  .actor-chip.chip-selected {
    border-color: #8f5a44;
    background: #2a211e;
    color: #ffd4bf;
  }
  .chip-index {
    color: #8b9f96;
    font: 10px var(--mono);
    padding-right: 7px;
    border-right: 1px solid #39443d;
  }
  .chip-selected .chip-index {
    color: var(--orange);
    border-right-color: #654532;
  }
  .chip-name {
    min-width: 0;
    max-width: 16ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .connection-budget {
    margin-left: auto;
    color: #7f8e9d;
    font: 10px var(--mono);
    white-space: nowrap;
  }
  .activity-line {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 12px 24px;
    border-top: 1px solid #28323d;
    color: #9cacb9;
    font: 13px/1.6 var(--mono);
    overflow-wrap: anywhere;
  }
  .activity-line > span {
    color: var(--mint);
    font-size: 17px;
  }
  .code-workspace {
    border-top: 1px solid #303945;
    background: #0c1017;
  }
  .code-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 0 24px;
    border-bottom: 1px solid #252d39;
  }
  .code-toolbar > div {
    display: flex;
    gap: 23px;
  }
  .code-toolbar button {
    min-height: 48px;
    padding: 0;
    background: none;
    color: #8e9bad;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    font-size: 12px;
    gap: 0;
    font-weight: 500;
  }
  .code-toolbar button:hover {
    background: none;
    color: #d7e4df;
  }
  .code-toolbar .tab-active {
    color: #9ce9c6;
    border-bottom-color: var(--mint);
  }
  .code-toolbar > span {
    font: 9px var(--mono);
    color: #6d7d8d;
    letter-spacing: 0.1em;
  }
  .code-workspace pre {
    height: 212px;
    margin: 0;
    padding: 24px;
    overflow: auto;
    color: #b9d6c7;
    font: 13px/1.85 var(--mono);
    scrollbar-width: thin;
  }
  .playground-footnote {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    padding: 16px 24px;
    border-top: 1px solid #252d39;
    color: #a3a9b3;
    font-size: 13px;
    line-height: 1.6;
  }
  .playground-footnote a {
    color: #b0c4bc;
    white-space: nowrap;
    text-decoration: none;
  }
  .playground-footnote a:hover {
    color: var(--mint);
  }
  .session-status {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 9px 12px;
    padding: 12px 26px;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: 12px;
    background: #111720;
  }
  .session-status code {
    color: #b5c8bf;
    font: 11px var(--mono);
  }
  .session-members {
    margin-left: auto;
  }
  .session-members strong {
    color: var(--ink);
    font-weight: 500;
  }
  .temporary-session {
    color: #e4be9f;
    font-size: 11px;
  }
  .session-error {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 14px 26px;
    border-bottom: 1px solid #56382f;
    background: #241b19;
  }
  .session-error p {
    color: #ffc5ae;
    font-size: 13px;
    line-height: 1.6;
    margin: 0;
    flex: 1;
  }
  .session-error button,
  .reconnect-action {
    min-height: 44px;
    padding: 9px 13px;
    border-radius: 5px;
    gap: 0;
    font-size: 12px;
  }
  .client-loading {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 14px;
    padding: 30px;
    min-height: 498px;
    height: auto;
    text-align: center;
  }
  .client-loading strong {
    color: var(--ink);
    font-weight: 500;
  }
  .client-loading p {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.7;
  }
  .code-toolbar > div {
    flex-wrap: wrap;
    gap: 0 23px;
  }
  @media (max-width: 700px) {
    .session-status {
      padding: 12px 17px;
    }
    .session-members {
      margin-left: 0;
    }
    .session-error {
      padding: 14px 17px;
      flex-wrap: wrap;
    }
    .client-loading {
      min-height: 400px;
    }
    .code-toolbar > div {
      gap: 0 16px;
    }
  }
  @media (max-width: 960px) {
    .runtime-grid {
      grid-template-columns: minmax(0, 1.4fr) minmax(280px, 1fr);
    }
    .toolbar-heading h3 {
      font-size: 21px;
    }
    .toolbar-actions {
      gap: 16px;
    }
    .client-content {
      padding: 21px 19px 16px;
    }
    .field-heading > span:last-child {
      display: none;
    }
    .field-controls {
      padding: 7px 10px;
    }
    .message-legend {
      gap: 10px;
    }
    .camera-controls button {
      padding: 6px;
    }
    .playground-footnote {
      flex-direction: column;
      gap: 8px;
    }
  }
  @media (max-width: 700px) {
    .playground-toolbar {
      align-items: flex-start;
      padding: 21px 18px;
      gap: 18px;
      flex-wrap: wrap;
    }
    .toolbar-heading {
      width: 100%;
    }
    .toolbar-heading h3 {
      font-size: 23px;
    }
    .toolbar-actions {
      width: 100%;
      justify-content: space-between;
    }
    .runtime-grid {
      height: auto;
      grid-template-columns: 1fr;
    }
    .actor-field {
      height: 450px;
    }
    .scene-viewport {
      min-height: 0;
    }
    .field-heading {
      padding: 19px 17px 0;
    }
    .field-controls {
      padding: 6px 12px;
    }
    .message-legend {
      width: 100%;
      gap: 18px;
    }
    .camera-controls {
      width: 100%;
      justify-content: flex-end;
    }
    .gateway-legend {
      display: flex;
    }
    .camera-controls button {
      min-height: 44px;
    }
    .svelte-client {
      border-left: 0;
      border-top: 1px solid #2e3641;
    }
    .client-content {
      height: auto;
      min-height: 450px;
      padding: 23px;
    }
    .client-state {
      padding: 24px 0;
    }
    .client-state output {
      font-size: 76px;
    }
    .client-state p,
    .key-form p {
      font-size: 13px;
    }
    .key-form input {
      font-size: 16px;
    }
    .client-footer {
      margin-top: 22px;
    }
    .actor-dock {
      padding: 16px 17px;
    }
    .actor-chip {
      min-height: 44px;
      font-size: 12px;
    }
    .connection-budget {
      width: 100%;
      margin-top: 5px;
    }
    .activity-line {
      padding: 13px 17px;
    }
    .code-toolbar {
      padding: 0 17px;
    }
    .code-toolbar > div {
      gap: 17px;
    }
    .code-toolbar button {
      font-size: 11px;
    }
    .code-toolbar > span {
      display: none;
    }
    .code-workspace pre {
      padding: 20px 17px;
      font-size: 13px;
    }
    .playground-footnote {
      padding: 15px 17px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
