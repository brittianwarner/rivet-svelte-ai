<script lang="ts">
  /**
   * A placeholder the size of the content it stands in for, so nothing moves
   * when the content arrives. It stays invisible for the first 150 ms: a warm
   * load replaces it before it ever shows.
   */
  let {
    width = "100%",
    height = "1em",
    round = false,
  }: { width?: string; height?: string; round?: boolean } = $props();
</script>

<span class="skeleton" class:round aria-hidden="true" style:width style:height
></span>

<style>
  .skeleton {
    display: inline-block;
    flex: none;
    max-width: 100%;
    vertical-align: middle;
    background: var(--surface);
    opacity: 0;
    animation:
      appear 0.2s ease-out 0.15s forwards,
      pulse 1.6s ease-in-out 0.35s infinite;
  }
  .round {
    border-radius: 50%;
  }
  @keyframes appear {
    to {
      opacity: 1;
    }
  }
  @keyframes pulse {
    50% {
      opacity: 0.55;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: appear 0s linear 0.15s forwards;
    }
  }
</style>
