<script lang="ts">
  let {
    actorKey,
    label,
    value,
    hasValue,
    connected,
    selected = false,
    pending = false,
    disabled = false,
    flat = false,
    onincrement,
    onselect,
  }: {
    actorKey: string;
    label: string;
    value: number;
    hasValue: boolean;
    connected: boolean;
    selected?: boolean;
    pending?: boolean;
    disabled?: boolean;
    flat?: boolean;
    onincrement: () => void;
    onselect: () => void;
  } = $props();

  const id = $props.id();
  const atLimit = $derived(hasValue && value >= Number.MAX_SAFE_INTEGER);
  const compact = $derived(
    !hasValue
      ? "—"
      : atLimit
        ? "MAX"
        : value > 9999
          ? new Intl.NumberFormat("en", {
              notation: "compact",
              maximumFractionDigits: 1,
            }).format(value)
          : String(value).padStart(2, "0"),
  );
  const number = $derived(label.replace(/^counter-/, ""));
</script>

<span
  class={["actor-block", { selected, flat, pending }]}
  data-actor-key={actorKey}
>
  <span id={`${id}-identity`} class="sr-only">
    {label}. Key {actorKey}.
    {hasValue ? `Displayed value ${value}.` : "Saved count not loaded yet."}
    {connected ? "Socket connected." : "Socket disconnected."}
  </span>
  <button
    type="button"
    class="increment-action actor-face"
    class:compact={compact.length > 3}
    aria-label={`Increment ${label}`}
    aria-describedby={`${id}-identity`}
    aria-busy={pending}
    title={hasValue
      ? `${label}: ${value}`
      : `${label}: waiting for saved count`}
    disabled={disabled || !connected || !hasValue || atLimit || pending}
    onclick={onincrement}
  >
    <span class="face-value" aria-hidden="true">{compact}</span>
    <span class="face-action" aria-hidden="true">
      {pending ? "WAITING" : atLimit ? "AT LIMIT" : "ADD 1"}
    </span>
  </button>
  <button
    type="button"
    class="actor-marker actor-chip"
    aria-label={`Inspect actor ${label}`}
    aria-pressed={selected}
    aria-describedby={`${id}-identity`}
    title={`Select ${label} without changing its value`}
    onclick={onselect}
  >
    <span>{selected ? "Selected" : "Select"}</span>
    <span class="actor-number">{number}</span>
  </button>
</span>

<style>
  .actor-block {
    --face-width: 132px;
    --face-height: 118px;
    display: inline-flex;
    width: var(--face-width);
    flex-direction: column;
    align-items: stretch;
    margin: 12px 10px 0 0;
    vertical-align: middle;
    perspective: 700px;
    letter-spacing: 0;
  }
  button {
    font: inherit;
    border-radius: 0;
    cursor: pointer;
    min-height: 44px;
    touch-action: manipulation;
  }
  .actor-face {
    position: relative;
    isolation: isolate;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0;
    width: var(--face-width);
    height: var(--face-height);
    padding: 7px 2px 22px;
    border: 1px solid var(--ink);
    background: var(--paper);
    color: var(--ink);
    box-shadow:
      8px -8px 0 #d9dcd5,
      9px -9px 0 var(--ink);
    transform-style: preserve-3d;
    transition:
      transform 150ms ease,
      background 150ms ease;
    font:
      600 65px/1 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
  }
  .actor-face::before {
    content: "";
    position: absolute;
    z-index: -1;
    top: -5px;
    right: -10px;
    width: 8px;
    height: 100%;
    border: 1px solid var(--ink);
    background: #c3c8bd;
    transform: skewY(-45deg) translateZ(-1px);
    transform-origin: left top;
  }
  .selected .actor-face {
    background: var(--red);
    color: white;
    box-shadow:
      8px -8px 0 #973620,
      9px -9px 0 var(--ink);
  }
  .selected .actor-face::before {
    background: #973620;
  }
  .actor-face:hover:not(:disabled) {
    transform: translateY(-3px) rotateY(-3deg);
  }
  .actor-face:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }
  .actor-face.compact {
    font-size: 30px;
  }
  .face-action {
    position: absolute;
    bottom: 9px;
    left: 0;
    right: 0;
    text-align: center;
    font:
      12px/1 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    letter-spacing: 0;
  }
  .pending .actor-face {
    border-style: dashed;
  }
  .actor-chip {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0 5px;
    width: 100%;
    padding: 6px 0;
    border: 0;
    border-bottom: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    font:
      12px/1.35 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    overflow-wrap: anywhere;
  }
  .actor-chip:hover {
    background: transparent;
    color: var(--ink);
  }
  .selected .actor-chip {
    border-bottom-color: var(--ink);
    color: var(--ink);
  }
  .actor-number {
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  button:focus-visible {
    outline: 3px solid var(--red);
    outline-offset: 5px;
  }
  .flat .actor-face,
  .flat.selected .actor-face {
    box-shadow: none;
    transform: none;
  }
  .flat .actor-face::before {
    display: none;
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
  @media (max-width: 700px) {
    .actor-block {
      --face-width: 86px;
      --face-height: 86px;
      margin-right: 5px;
    }
    .actor-face {
      font-size: 40px;
    }
    .actor-face.compact {
      font-size: 24px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .actor-face,
    .actor-face:hover:not(:disabled) {
      transition: none;
      transform: none;
    }
  }
</style>
