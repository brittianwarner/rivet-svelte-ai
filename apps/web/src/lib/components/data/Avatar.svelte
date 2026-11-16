<script lang="ts">
  /** Same hue rule as the user actor, so an avatar matches before the profile loads. */
  function hueFor(id: string): number {
    let hash = 0;
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return hash;
  }

  let {
    id,
    name,
    size = 28,
  }: { id: string; name: string; size?: number } = $props();

  const initial = $derived((name.trim()[0] ?? id[0] ?? "?").toUpperCase());
  const hue = $derived(hueFor(id));
</script>

<span
  class="avatar"
  aria-hidden="true"
  style:--hue={hue}
  style:--size={`${size}px`}>{initial}</span
>

<style>
  .avatar {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: var(--size);
    height: var(--size);
    background: hsl(var(--hue) 45% 88%);
    color: hsl(var(--hue) 55% 26%);
    font-size: calc(var(--size) * 0.46);
    font-weight: 700;
    line-height: 1;
  }
  :global([data-theme="dark"]) .avatar {
    background: hsl(var(--hue) 35% 26%);
    color: hsl(var(--hue) 70% 86%);
  }
</style>
