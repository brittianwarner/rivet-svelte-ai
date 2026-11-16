<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
</script>

<!-- Renders inside the data shell, which already owns <main>. -->
<section class="data-error" aria-labelledby="data-error-title">
  <p class="eyebrow">DATA / {page.status}</p>
  <h1 id="data-error-title">
    {page.error?.message ?? "Something went wrong."}
  </h1>
  <a class="inline-link" href={resolve("/data")}>Reload the data browser</a>
</section>

<style>
  .data-error {
    display: grid;
    gap: 16px;
    max-width: 640px;
    padding: 64px clamp(16px, 5vw, 64px);
  }
  h1 {
    font-size: 28px;
    line-height: 1.2;
  }
</style>
