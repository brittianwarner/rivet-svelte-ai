<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { SESSION_ACTOR_LIMIT } from "@example/wire";
  import { actorExamples } from "#lib/visuals/actor-examples.js";
  import type {
    SessionCounter,
    SessionViewModel,
  } from "#lib/view-models/session-view-model.svelte.js";
  import type { CounterViewModel } from "#lib/view-models/counter-view-model.svelte.js";
  import ActorBlock from "./ActorBlock.svelte";

  let { session }: { session: SessionViewModel } = $props();
  const id = $props.id();
  type Receipt = {
    text: string;
    error?: string;
    model: CounterViewModel;
    connection: CounterViewModel["actor"];
  };
  type Request = {
    key: string;
    model: CounterViewModel;
    connection: CounterViewModel["actor"];
    viaHttp: boolean;
  };
  let flat = $state(false);
  let slots = $state<(string | null)[]>(
    Array.from({ length: SESSION_ACTOR_LIMIT }, () => null),
  );
  let receipts = $state.raw<Record<string, Receipt>>({});
  let request = $state.raw<Request | null>(null);
  let removed = $state<{ key: string; label: string; slot: number } | null>(
    null,
  );
  let removalStatus = $state("");
  let keyDraft = $derived(session.selectedKey);
  let settingsOpen = $state(false);
  let codeTab = $state<"state" | "svelte" | "view-model" | "session">("state");
  let inspectorHeading = $state.raw<HTMLHeadingElement | undefined>(undefined);
  let addButton = $state.raw<HTMLButtonElement | undefined>(undefined);
  let undoButton = $state.raw<HTMLButtonElement | undefined>(undefined);
  let connectionButton = $state.raw<HTMLButtonElement | undefined>(undefined);
  let alive = true;
  let focusedActorKey = "";

  const entry = $derived(
    session.actors.find((item) => item.key === session.selectedKey) ??
      session.actors[0],
  );
  const model = $derived(entry?.model ?? null);
  const slotEntries = $derived(
    slots.map((key) => session.actors.find((item) => item.key === key)),
  );
  const heroActor = $derived(slotEntries[0]);
  const lastSlot = $derived(
    Math.max(0, ...slots.map((key, index) => (key ? index : 0))),
  );
  const headlineAdd = $derived(!heroActor && !session.loading);
  const atCapacity = $derived(session.actors.length >= SESSION_ACTOR_LIMIT);
  const undoBlocked = $derived(
    !!removed &&
      atCapacity &&
      !session.actors.some((item) => item.key === removed?.key),
  );
  const membershipBlocked = $derived(!session.canMutate || request !== null);
  const actionBlocked = $derived(
    session.loading || session.pending || request !== null,
  );
  const atLimit = $derived(
    !!model?.hasValue && model.count >= Number.MAX_SAFE_INTEGER,
  );
  const selectedReceipt = $derived(
    entry &&
      receipts[entry.key]?.model === model &&
      receipts[entry.key]?.connection === model?.actor
      ? receipts[entry.key]
      : undefined,
  );
  const sessionError = $derived(session.error ?? session.connectionError);
  const valueStatus = $derived(
    !model
      ? session.loading
        ? "Restoring your session…"
        : "Add an actor to begin."
      : model.snapshotError
        ? model.hasValue
          ? "Last known value · saved count could not be refreshed."
          : "Saved count unavailable."
        : model.snapshotPending
          ? model.hasValue
            ? "Refreshing saved count · showing last known value."
            : "Loading saved count…"
          : !model.hasValue
            ? "Waiting for the saved count…"
            : atLimit
              ? "Maximum safe count reached."
              : model.connected
                ? "Rivet owns this count. Svelte displays it."
                : "Known value · socket offline. HTTP remains available.",
  );
  const activity = $derived(
    selectedReceipt?.text ??
      (model?.snapshotError
        ? "Retry loading the saved count."
        : model?.snapshotPending
          ? "Reading saved count…"
          : model?.hasValue
            ? "Select inspects. Add 1 changes only that actor."
            : session.loading
              ? "Restoring your saved actors…"
              : entry
                ? "Waiting for the first saved count."
                : "No saved actors. Add one to give state a home."),
  );
  const actionError = $derived(
    selectedReceipt ? selectedReceipt.error : model?.error,
  );
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
        ? model?.hasValue
          ? JSON.stringify({ count: model.count }, null, 2)
          : entry
            ? "// Waiting for the saved count. Zero is not assumed."
            : session.loading
              ? "// Restoring your session…"
              : "// Add an actor to inspect its state."
        : codeTab === "svelte"
          ? examples.component
          : examples.viewModel,
  );

  // Slot assignment is bounded presentation metadata. Server membership remains authoritative.
  // Reconcile external session snapshots without moving surviving keyed objects.
  $effect(() => {
    const keys = session.actors.map((item) => item.key);
    untrack(() => {
      const next = slots.map((key) => (key && keys.includes(key) ? key : null));
      for (const key of keys) {
        if (next.includes(key)) continue;
        const preferred = removed?.key === key ? removed.slot : -1;
        const free =
          preferred >= 0 && next[preferred] === null
            ? preferred
            : next.indexOf(null);
        if (free >= 0) next[free] = key;
      }
      if (next.some((key, index) => key !== slots[index])) slots = next;
      if (Object.keys(receipts).some((key) => !keys.includes(key))) {
        receipts = Object.fromEntries(
          Object.entries(receipts).filter(([key]) => keys.includes(key)),
        );
      }
      if (removed && keys.includes(removed.key)) {
        removalStatus = `${removed.label} is back in the session.`;
        removed = null;
      }
      if (focusedActorKey && !keys.includes(focusedActorKey)) {
        focusedActorKey = "";
        void focusInspector();
      }
    });
  });

  onDestroy(() => {
    alive = false;
  });

  function rememberFocus(event: FocusEvent): void {
    focusedActorKey =
      event.target instanceof HTMLElement
        ? (event.target.closest<HTMLElement>("[data-actor-key]")?.dataset
            .actorKey ?? "")
        : "";
  }
  async function focusInspector(key?: string): Promise<void> {
    await tick();
    if (!alive || (key && session.selectedKey !== key)) return;
    inspectorHeading?.focus({ preventScroll: true });
    inspectorHeading?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
  function selectActor(key: string): void {
    session.select(key);
    void focusInspector(key);
  }
  function receipt(target: SessionCounter, text: string, error?: string): void {
    if (
      !alive ||
      !session.actors.some(
        (item) => item.key === target.key && item.model === target.model,
      )
    )
      return;
    receipts = {
      ...receipts,
      [target.key]: {
        text,
        error,
        model: target.model,
        connection: target.model.actor,
      },
    };
  }
  async function addActor(): Promise<void> {
    if (membershipBlocked || atCapacity) return;
    await session.createCounter();
    if (alive) await focusInspector();
  }
  async function removeActor(): Promise<void> {
    if (!entry || membershipBlocked) return;
    const target = {
      key: entry.key,
      label: entry.label,
      slot: slots.indexOf(entry.key),
    };
    await session.removeCounter(target.key);
    if (!alive) return;
    if (session.error) {
      await focusInspector();
      return;
    }
    if (!session.actors.some((item) => item.key === target.key)) {
      removed = target;
      removalStatus = `${target.label} removed from this session. Its state is retained.`;
    }
    await tick();
    const focus = undoButton ?? addButton ?? inspectorHeading;
    focus?.focus({ preventScroll: true });
    focus?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
  async function undoRemove(): Promise<void> {
    if (!removed || membershipBlocked || undoBlocked) return;
    const target = removed;
    await session.attachCounter(target.key, target.label);
    if (!alive) return;
    if (!session.error) {
      removed = null;
      removalStatus = `${target.label} restored with its existing state.`;
    }
    await focusInspector();
  }
  async function disconnect(): Promise<void> {
    if (!entry || request || session.pending) return;
    const target = entry;
    session.disconnect(target.key);
    receipt(target, `Socket disconnected · ${target.label}. State retained.`);
    await tick();
    connectionButton?.focus({ preventScroll: true });
    connectionButton?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
  async function reconnect(): Promise<void> {
    if (!entry || request || session.pending) return;
    const target = entry;
    session.reconnect(target.key);
    receipts = Object.fromEntries(
      Object.entries(receipts).filter(([key]) => key !== target.key),
    );
    await focusInspector(target.key);
  }
  async function refreshCount(): Promise<void> {
    if (
      !entry ||
      request ||
      !entry.model.connected ||
      entry.model.snapshotPending
    )
      return;
    const target = entry;
    const connection = target.model.actor;
    await target.model.refreshCount();
    if (
      !alive ||
      target.model.name !== target.key ||
      target.model.actor !== connection
    )
      return;
    if (!target.model.snapshotError && target.model.hasValue)
      receipt(target, `Snapshot refreshed · ${target.label}.`);
  }
  async function send(target: SessionCounter, viaHttp = false): Promise<void> {
    const owner = target.model;
    if (
      actionBlocked ||
      owner.name !== target.key ||
      (!viaHttp &&
        (!owner.connected || !owner.hasValue || owner.snapshotPending)) ||
      (owner.hasValue && owner.count >= Number.MAX_SAFE_INTEGER)
    )
      return;
    const captured: Request = {
      key: target.key,
      model: owner,
      connection: owner.actor,
      viaHttp,
    };
    request = captured;
    session.select(target.key);
    receipt(
      target,
      `Waiting for ${viaHttp ? "HTTP" : "action"} response · ${target.label}.`,
    );
    void focusInspector(target.key);
    try {
      if (viaHttp) await owner.incrementViaHttp();
      else await owner.increment();
      if (!alive) return;
      const sameMember = session.actors.some(
        (item) => item.key === captured.key && item.model === owner,
      );
      if (!sameMember || owner.name !== captured.key) return;
      if (owner.actor !== captured.connection) {
        receipt(
          target,
          `Connection changed · ${target.label}. Check its current count before another action.`,
        );
        return;
      }
      if (owner.error)
        receipt(
          target,
          `Request needs attention · ${target.label}.`,
          owner.error,
        );
      else
        receipt(
          target,
          `${viaHttp ? "HTTP response" : "Action response"} received · ${target.label}.${viaHttp && !owner.connected ? " Socket offline." : ""}`,
        );
    } catch (error) {
      if (owner.name === captured.key && owner.actor === captured.connection) {
        receipt(
          target,
          `Request needs attention · ${target.label}.`,
          error instanceof Error
            ? error.message
            : "The request could not be completed.",
        );
      }
    } finally {
      if (alive && request === captured) request = null;
    }
  }
  async function connectKey(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (membershipBlocked) return;
    const key = keyDraft.trim().toLowerCase();
    await session.attachCounter(key);
    if (!alive) return;
    const target = session.actors.find((item) => item.key === key);
    if (!session.error && target) {
      receipts = Object.fromEntries(
        Object.entries(receipts).filter(([stored]) => stored !== key),
      );
    }
    await focusInspector();
  }
</script>

<svelte:document onfocusin={rememberFocus} />

{#snippet addControl(inHeadline = false)}
  <button
    type="button"
    class={["canvas-add", { "headline-add": inHeadline }]}
    aria-label="Add actor"
    title={atCapacity
      ? "Seven actors saved. Remove one to make room."
      : "Create an independent counter"}
    bind:this={addButton}
    disabled={membershipBlocked || atCapacity}
    onclick={addActor}
  >
    {#if inHeadline}<span>one</span><span class="add-caption">+ ADD ACTOR</span>
    {:else}<span>{session.pending ? "Saving…" : "+ Add actor"}</span>{/if}
  </button>
{/snippet}

{#snippet undoControl()}
  <button
    type="button"
    class="undo-remove"
    aria-label="Undo remove"
    title={removed ? `Restore ${removed.label}` : undefined}
    bind:this={undoButton}
    disabled={membershipBlocked || undoBlocked}
    onclick={undoRemove}>Undo remove</button
  >
{/snippet}

<section class="actor-playground" aria-label="Live actor anatomy" class:flat>
  <div class="session-status" data-session-id={session.id}>
    <span class="session-identity"
      ><i class:online={session.connected} aria-hidden="true"
      ></i>{session.loading
        ? "Restoring session…"
        : session.pending
          ? "Saving membership…"
          : session.connected
            ? "Session connected"
            : "Session reconnecting…"}</span
    >
    <span class="session-counts"
      ><strong aria-label="Session actors">{session.actors.length}</strong>
      saved <span aria-hidden="true">/</span>
      <strong aria-label="Connected actors">{session.connectedActors}</strong> connected</span
    >
    <button
      type="button"
      class="flat-toggle"
      aria-pressed={flat}
      onclick={() => {
        flat = !flat;
      }}>Flat view</button
    >
  </div>
  {#if sessionError}
    <div class="session-error">
      <p role="alert">{sessionError}</p>
      <button
        type="button"
        disabled={session.pending || request !== null}
        onclick={() => void session.retry()}>Retry session</button
      >
    </div>
  {/if}
  {#if session.temporary}<p class="temporary-session">
      Temporary session · browser storage is unavailable.
    </p>{/if}

  <div class="runtime-grid">
    <h1
      class="headline"
      aria-label={headlineAdd
        ? session.actors.length
          ? "Add an actor. Or change a neighbor."
          : "Add an actor. Give state a home."
        : "Change one actor at a time."}
    >
      <span class="headline-line">
        <span>{headlineAdd ? "Add" : "Change"}</span>
        {#if heroActor}
          {#key heroActor.key}
            <ActorBlock
              actorKey={heroActor.key}
              label={heroActor.label}
              value={heroActor.model.count}
              hasValue={heroActor.model.hasValue}
              connected={heroActor.model.connected}
              selected={session.selectedKey === heroActor.key}
              pending={request?.key === heroActor.key}
              disabled={actionBlocked || heroActor.model.snapshotPending}
              {flat}
              onincrement={() => void send(heroActor)}
              onselect={() => selectActor(heroActor.key)}
            />
          {/key}
        {:else if headlineAdd}
          <span class="vacant-slot">{@render addControl(true)}</span>
        {:else}<span class="waiting-slot" aria-label="Restoring actors">—</span
          >{/if}
        <span class="headline-period">.</span>
      </span>
      <span class="headline-subline"
        >{headlineAdd
          ? session.actors.length
            ? "Or change a neighbor."
            : "Give state a home."
          : "One at a time."}</span
      >
    </h1>

    <section
      class="svelte-client"
      aria-label="Svelte client"
      data-actor-key={entry?.key}
    >
      <div class="client-chrome">
        <span>SVELTE VIEW / SELECTED ACTOR</span><span
          >{model?.connected
            ? "CONNECTED"
            : model?.actor
              ? "CONNECTING"
              : "OFFLINE"}</span
        >
      </div>
      <div class="client-content">
        <div class="client-actor">
          <span class="selection-mark" aria-hidden="true"></span>
          <h2 bind:this={inspectorHeading} tabindex="-1">
            {entry?.label ??
              (session.loading ? "Restoring actors…" : "Empty session")}
          </h2>
        </div>
        {#if entry && model}
          <code class="selected-key" title={entry.key}>{entry.key}</code>
          <div class="client-state">
            <output
              aria-label="Counter value"
              aria-live="polite"
              aria-describedby={`${id}-value-status`}
              class:long-value={model.hasValue &&
                String(model.count).length > 10}
              >{model.hasValue ? String(model.count) : "—"}</output
            >
            <p id={`${id}-value-status`}>{valueStatus}</p>
          </div>
          <div class="selected-actions">
            <button
              type="button"
              class="increment-action"
              disabled={actionBlocked ||
                !model.connected ||
                !model.hasValue ||
                model.snapshotPending ||
                atLimit}
              onclick={() => void send(entry)}>+ Increment</button
            >
            <button
              type="button"
              class="http-action"
              disabled={actionBlocked || model.httpPending || atLimit}
              onclick={() => void send(entry, true)}>+ Via HTTP</button
            >
          </div>
          <div class="client-buttons">
            <button
              type="button"
              class="canvas-remove"
              aria-label={`Remove ${entry.label} from playground`}
              disabled={membershipBlocked}
              onclick={removeActor}>Remove</button
            >
            {#if removed}{@render undoControl()}{/if}
            {#if !headlineAdd}{@render addControl()}{/if}
          </div>
          <div class="connection-actions">
            {#if !model.actor}
              <button
                type="button"
                class="reconnect-action"
                bind:this={connectionButton}
                disabled={request !== null || session.pending}
                onclick={reconnect}>Reconnect actor</button
              >
            {:else}
              <button
                type="button"
                class="disconnect-action"
                bind:this={connectionButton}
                disabled={request !== null || session.pending}
                onclick={disconnect}>Disconnect actor</button
              >
            {/if}
            <span
              >{model.connected
                ? "Direct actor socket"
                : "State stays in Rivet"}</span
            >
          </div>
          {#if model.snapshotError}
            <div class="count-recovery">
              <p class="client-error" role="alert">{model.snapshotError}</p>
              <button
                type="button"
                disabled={model.snapshotPending ||
                  !model.connected ||
                  request !== null}
                onclick={refreshCount}>Retry count</button
              >
            </div>
          {/if}
          {#if actionError}
            <div class="count-recovery">
              <p class="client-error" role="alert">
                {actionError} The request may have reached the actor. Check its current
                count before sending another increment.
              </p>
              {#if model.connected && !model.snapshotError}
                <button
                  type="button"
                  disabled={model.snapshotPending || request !== null}
                  onclick={refreshCount}>Check current count</button
                >
              {/if}
            </div>
          {/if}
        {:else}
          <p class="empty-copy">
            {session.loading
              ? "Your session remembers its counters in Rivet. Waiting for the saved registry."
              : "Your session is intentionally empty. Add an actor when you are ready."}
          </p>
          {#if !headlineAdd}{@render addControl()}{/if}
        {/if}
        <div class="activity-line" role="status" aria-live="polite">
          <span aria-hidden="true">↳</span><span>{activity}</span>
        </div>
        {#if removed}
          <div class="removal-recovery">
            {#if !entry}{@render undoControl()}{/if}
            {#if undoBlocked}<p>
                Seven other actors are saved. Remove one to make room for this
                actor.
              </p>{/if}
          </div>
        {/if}
        <span class="sr-only" role="status">{removalStatus}</span>
        <details class="connection-settings" bind:open={settingsOpen}>
          <summary
            >Connect an actor key <span aria-hidden="true">＋</span></summary
          >
          <form class="key-form" onsubmit={connectKey}>
            <label for={`${id}-actor-key`}>Actor key</label>
            <div class="key-input-row">
              <input
                id={`${id}-actor-key`}
                bind:value={keyDraft}
                required
                maxlength="64"
                pattern={"[a-zA-Z0-9][a-zA-Z0-9\\-]{0,63}"}
                spellcheck="false"
                aria-describedby={`${id}-key-help`}
                title="Use 1–64 letters, numbers, or hyphens. Start with a letter or number. Keys become lowercase."
                disabled={membershipBlocked}
              /><button type="submit" disabled={membershipBlocked}
                >Connect</button
              >
            </div>
            <p id={`${id}-key-help`}>
              Same key, same state. Use 1–64 letters, numbers or hyphens. An
              existing session member can be connected even when all seven
              places are filled.
            </p>
          </form>
        </details>
      </div>
    </section>

    {#if lastSlot > 0}
      <div class="neighbor-field">
        <div class="field-heading">
          <span>INDEPENDENT NEIGHBORS</span><span class="field-scroll-hint"
            >SCROLL TO EXPLORE ↓</span
          >
        </div>
        <div class="actor-dock" aria-label="Playground actors">
          {#each slotEntries.slice(1, lastSlot + 1) as actor, index (index)}
            <div class="actor-slot">
              {#if actor}
                {#key actor.key}
                  <ActorBlock
                    actorKey={actor.key}
                    label={actor.label}
                    value={actor.model.count}
                    hasValue={actor.model.hasValue}
                    connected={actor.model.connected}
                    selected={session.selectedKey === actor.key}
                    pending={request?.key === actor.key}
                    disabled={actionBlocked || actor.model.snapshotPending}
                    {flat}
                    onincrement={() => void send(actor)}
                    onselect={() => selectActor(actor.key)}
                  />
                {/key}
              {:else}<span class="available-slot">Available place</span>{/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
    <div class="playground-intro">
      <p>
        Disconnect closes this socket. Remove changes session membership.
        Neither destroys the actor.
      </p>
    </div>
  </div>

  <div class="code-workspace" class:compact-code={codeTab === "state"}>
    <div class="code-toolbar">
      <div role="group" aria-label="Code view">
        <button
          type="button"
          class:tab-active={codeTab === "state"}
          aria-pressed={codeTab === "state"}
          onclick={() => {
            codeTab = "state";
          }}>Live state</button
        >
        <button
          type="button"
          class:tab-active={codeTab === "svelte"}
          aria-label="Svelte connection"
          aria-pressed={codeTab === "svelte"}
          onclick={() => {
            codeTab = "svelte";
          }}>Svelte component</button
        >
        <button
          type="button"
          class:tab-active={codeTab === "view-model"}
          aria-pressed={codeTab === "view-model"}
          onclick={() => {
            codeTab = "view-model";
          }}>View model</button
        >
        <button
          type="button"
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
    <div class="playground-footnote">
      <span
        >Rivet routes each action to its actor. Events update connected views;
        reconnect reads the latest state.</span
      ><a
        href="https://github.com/brittianwarner/rivet-svelte-ai/blob/main/docs/first-actor.md"
        >Build your first actor ↗</a
      >
    </div>
  </div>
</section>

<style>
  .actor-playground {
    color: var(--ink);
    background: var(--paper);
    font-family: Arial, Helvetica, sans-serif;
    min-width: 0;
  }
  button,
  input {
    font: inherit;
    border-radius: 0;
  }
  button {
    cursor: pointer;
    touch-action: manipulation;
    min-height: 44px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--ink);
    padding: 10px 13px;
    font-size: 12px;
    font-weight: 400;
  }
  button:hover {
    background: #e8ebe4;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button:focus-visible,
  input:focus-visible,
  summary:focus-visible,
  pre:focus-visible {
    outline: 3px solid var(--red);
    outline-offset: 4px;
  }
  h1,
  h2,
  p {
    margin: 0;
  }
  .session-status {
    display: flex;
    align-items: center;
    gap: 16px;
    border-top: 1px solid var(--ink);
    border-bottom: 1px solid var(--line);
    padding: 12px 0;
    font:
      11px/1.5 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
  }
  .session-identity {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .session-identity i {
    display: inline-block;
    width: 7px;
    height: 7px;
    border: 1px solid var(--muted);
    border-radius: 50%;
  }
  .session-identity i.online {
    background: var(--red);
    border-color: var(--red);
  }
  .session-counts {
    margin-left: auto;
    white-space: nowrap;
  }
  .session-counts strong {
    font-weight: 600;
  }
  .flat-toggle {
    min-height: 44px;
    padding: 5px 10px;
    font-size: 11px;
  }
  .flat-toggle[aria-pressed="true"] {
    background: var(--ink);
    color: var(--paper);
  }
  .session-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 0;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
    color: #9d2819;
  }
  .session-error button {
    flex-shrink: 0;
  }
  .temporary-session {
    font-size: 12px;
    color: var(--muted);
    margin-top: 12px;
  }
  .runtime-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(330px, 1fr);
    column-gap: 48px;
    align-items: start;
    padding: 40px 0 28px;
  }
  .headline {
    grid-column: 1;
    grid-row: 1;
    margin: 0;
    font:
      600 clamp(56px, 6vw, 82px)/1.05 Arial,
      Helvetica,
      sans-serif;
    letter-spacing: -0.075em;
  }
  .headline-line {
    display: flex;
    align-items: center;
    gap: 20px;
    min-height: 170px;
  }
  .headline-period {
    margin-left: -10px;
  }
  .headline-subline {
    display: block;
    margin-top: 14px;
    font-size: 0.76em;
    letter-spacing: -0.065em;
    line-height: 1.1;
  }
  .vacant-slot {
    display: inline-flex;
    width: 132px;
    height: 118px;
    margin: 12px 10px 44px 0;
  }
  .headline-add {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    border: 1px solid var(--ink);
    box-shadow: 8px -8px 0 #bcc3b7;
    font-size: 38px;
    font-weight: 500;
    gap: 7px;
    padding: 12px 0;
  }
  .canvas-add {
    background: var(--ink);
    color: var(--paper);
    border-color: var(--ink);
  }
  .canvas-add:hover:not(:disabled) {
    background: #343a32;
  }
  .add-caption {
    font:
      12px ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    letter-spacing: 0;
  }
  .flat .headline-add {
    box-shadow: none;
  }
  .waiting-slot {
    display: inline-flex;
    width: 132px;
    height: 118px;
    align-items: center;
    justify-content: center;
    font-size: 55px;
    color: var(--muted);
  }
  .svelte-client {
    grid-column: 2;
    grid-row: 1 / 3;
    min-width: 0;
    scroll-margin-top: 18px;
    padding-top: 10px;
  }
  .client-chrome {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--ink);
    padding-bottom: 15px;
    font:
      10px/1.5 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    color: var(--muted);
  }
  .client-content {
    padding-top: 20px;
  }
  .client-actor {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .selection-mark {
    width: 9px;
    height: 9px;
    background: var(--red);
    flex-shrink: 0;
  }
  .client-actor h2 {
    font:
      600 15px/1.5 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    overflow-wrap: anywhere;
  }
  .client-actor h2:focus {
    outline: 2px solid var(--red);
    outline-offset: 5px;
  }
  .selected-key {
    display: block;
    font:
      12px/1.65 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    overflow-wrap: anywhere;
    word-break: break-all;
    color: var(--muted);
    margin: 8px 0 16px;
  }
  .client-state output {
    display: block;
    font:
      500 38px/1.1 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    letter-spacing: -0.04em;
    overflow-wrap: anywhere;
  }
  .client-state output.long-value {
    font-size: 22px;
    letter-spacing: 0;
  }
  .client-state p {
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted);
    margin: 8px 0 17px;
  }
  .selected-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 9px;
  }
  .selected-actions .increment-action {
    background: var(--red);
    color: white;
    border-color: var(--red);
  }
  .client-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .client-buttons button {
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .client-buttons .canvas-remove {
    border-color: transparent;
    text-decoration: underline;
    text-underline-offset: 4px;
  }
  .client-buttons .canvas-add {
    margin-left: auto;
  }
  .connection-actions {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 9px;
  }
  .connection-actions button {
    border: 0;
    padding: 6px 0;
    text-decoration: underline;
    text-underline-offset: 4px;
    text-align: left;
  }
  .connection-actions button:hover {
    background: transparent;
  }
  .connection-actions span {
    font-size: 11px;
    color: var(--muted);
  }
  .count-recovery {
    margin: 10px 0;
  }
  .client-error {
    font-size: 12px;
    line-height: 1.6;
    color: #9d2819;
    margin: 10px 0;
  }
  .activity-line {
    display: flex;
    gap: 9px;
    padding: 14px 0;
    min-height: 64px;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    margin-top: 10px;
    font:
      12px/1.65 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    overflow-wrap: anywhere;
  }
  .activity-line > span:last-child {
    min-width: 0;
  }
  .removal-recovery {
    display: flex;
    gap: 10px 14px;
    flex-wrap: wrap;
    align-items: center;
    margin: 12px 0;
    font-size: 12px;
    line-height: 1.6;
  }
  .removal-recovery p {
    flex-basis: 100%;
  }
  .empty-copy {
    color: var(--muted);
    font-size: 14px;
    line-height: 1.6;
    margin: 12px 0;
  }
  .connection-settings {
    margin-top: 6px;
    border-bottom: 1px solid var(--line);
  }
  .connection-settings summary {
    display: flex;
    justify-content: space-between;
    align-items: center;
    min-height: 48px;
    cursor: pointer;
    list-style: none;
    font-size: 12px;
  }
  .connection-settings summary::-webkit-details-marker {
    display: none;
  }
  .key-form {
    padding: 8px 0 15px;
  }
  .key-form label {
    display: block;
    font-size: 12px;
    margin-bottom: 7px;
  }
  .key-input-row {
    display: flex;
    gap: 8px;
  }
  .key-form input {
    min-width: 0;
    width: 100%;
    min-height: 44px;
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--line);
    padding: 9px;
    font:
      13px ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
  }
  .key-form p {
    font-size: 12px;
    line-height: 1.6;
    color: var(--muted);
    margin-top: 9px;
  }
  .neighbor-field {
    grid-column: 1;
    grid-row: 2;
    min-width: 0;
    margin: 28px 0 0;
  }
  .field-heading {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    font:
      10px/1.5 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    color: var(--muted);
    margin-bottom: 13px;
  }
  .actor-dock {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px 14px;
    max-height: 370px;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    padding: 8px 10px 10px 0;
  }
  .actor-slot {
    min-width: 0;
  }
  .available-slot {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 132px;
    height: 118px;
    margin: 12px 10px 44px 0;
    border: 1px dashed var(--line);
    color: var(--muted);
    font:
      11px ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
  }
  .playground-intro {
    grid-column: 1 / -1;
    grid-row: 3;
    display: grid;
    border-top: 1px solid var(--line);
    padding-top: 24px;
    margin-top: 28px;
  }
  .playground-intro p {
    font-size: 14px;
    line-height: 1.65;
    max-width: 760px;
    color: var(--muted);
  }
  .code-workspace {
    background: var(--ink);
    color: var(--paper);
    min-width: 0;
  }
  .code-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 0 22px;
    border-bottom: 1px solid #434a40;
  }
  .code-toolbar > div {
    display: flex;
    gap: 22px;
    flex-wrap: wrap;
  }
  .code-toolbar button {
    border: 0;
    border-bottom: 2px solid transparent;
    padding: 12px 0;
    background: none;
    color: #bbc2b6;
    min-height: 48px;
    font-size: 12px;
  }
  .code-toolbar button.tab-active {
    color: var(--paper);
    border-bottom-color: #f18168;
  }
  .code-toolbar > span {
    font:
      10px ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    color: #bbc2b6;
  }
  .code-workspace pre {
    margin: 0;
    height: 250px;
    overflow: auto;
    max-width: 100%;
    padding: 22px;
    white-space: pre;
    font:
      12px/1.8 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
  }
  .code-workspace.compact-code pre {
    height: 120px;
  }
  .playground-footnote {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 28px;
    border-top: 1px solid #434a40;
    padding: 18px 22px;
    color: #bbc2b6;
    font-size: 12px;
    line-height: 1.65;
  }
  .playground-footnote span {
    max-width: 690px;
  }
  .playground-footnote a {
    flex-shrink: 0;
    color: var(--paper);
    text-decoration: underline;
    text-underline-offset: 4px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  @media (max-width: 1099px) {
    .runtime-grid {
      display: flex;
      flex-direction: column;
      padding-top: 28px;
      gap: 0;
    }
    .headline {
      width: 100%;
      font-size: clamp(56px, 8vw, 88px);
    }
    .headline-subline {
      font-size: 0.72em;
    }
    .svelte-client {
      width: 100%;
      margin-top: 28px;
    }
    .neighbor-field {
      width: 100%;
      margin-top: 28px;
    }
    .actor-dock {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .playground-intro {
      width: 100%;
      gap: 28px;
    }
  }
  @media (max-width: 700px) {
    .session-status {
      gap: 8px 12px;
      flex-wrap: wrap;
      padding: 8px 0;
      font-size: 11px;
    }
    .session-identity {
      flex: 1;
      min-width: 130px;
    }
    .session-counts {
      margin-left: 0;
      order: 3;
      flex-basis: 100%;
      padding-bottom: 3px;
    }
    .session-error {
      flex-wrap: wrap;
    }
    .runtime-grid {
      padding-top: 18px;
      padding-bottom: 24px;
    }
    .headline {
      font-size: 52px;
    }
    .headline-line {
      gap: 12px;
      min-height: 135px;
    }
    .headline-period {
      margin-left: -6px;
    }
    .headline-subline {
      font-size: 0.73em;
      margin-top: 8px;
    }
    .vacant-slot {
      width: 86px;
      height: 86px;
      margin: 12px 5px 44px 0;
    }
    .headline-add {
      font-size: 28px;
    }
    .add-caption {
      font-size: 11px;
    }
    .waiting-slot {
      width: 86px;
      height: 86px;
      font-size: 42px;
    }
    .svelte-client {
      margin-top: 24px;
      padding-top: 0;
    }
    .client-chrome {
      font-size: 10px;
      padding-bottom: 12px;
    }
    .client-content {
      padding-top: 15px;
    }
    .client-actor h2 {
      font-size: 14px;
    }
    .selected-key {
      font-size: 12px;
      margin-bottom: 14px;
    }
    .client-state output {
      font-size: 34px;
    }
    .client-state output.long-value {
      font-size: 20px;
    }
    .client-buttons {
      gap: 7px;
    }
    .client-buttons button {
      min-width: 70px;
      padding: 9px 7px;
    }
    .connection-actions {
      gap: 12px;
    }
    .connection-actions span {
      font-size: 11px;
    }
    .key-form input {
      font-size: 16px;
    }
    .field-heading {
      font-size: 10px;
    }
    .field-scroll-hint {
      display: none;
    }
    .actor-dock {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px 18px;
      max-height: none;
      overflow: visible;
    }
    .available-slot {
      width: 86px;
      height: 86px;
      font-size: 11px;
      margin-right: 5px;
    }
    .playground-intro {
      grid-template-columns: 1fr;
      gap: 15px;
      padding-top: 18px;
      margin-top: 22px;
    }
    .playground-intro p {
      font-size: 13px;
    }
    .code-toolbar {
      padding: 0 16px;
    }
    .code-toolbar > div {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0 20px;
      width: 100%;
    }
    .code-toolbar > span {
      display: none;
    }
    .code-workspace pre {
      padding: 16px;
      height: 220px;
      font-size: 12px;
    }
    .playground-footnote {
      padding: 16px;
      flex-direction: column;
      gap: 10px;
    }
    .playground-footnote a {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
    }
  }
  @media (max-width: 370px) {
    .headline {
      font-size: 46px;
    }
    .headline-line {
      gap: 10px;
    }
    .headline-subline {
      font-size: 0.72em;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
