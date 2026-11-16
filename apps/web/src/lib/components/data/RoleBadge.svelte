<script lang="ts">
  import type { Role } from "@example/entities/contracts";

  let { role }: { role: Role } = $props();
</script>

<span class="role" data-role={role}>{role}</span>

<style>
  .role {
    display: inline-block;
    border: 1px solid var(--line);
    padding: 1px 7px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
    line-height: 18px;
    text-transform: lowercase;
    white-space: nowrap;
  }
  .role[data-role="owner"] {
    border-color: var(--ink);
    color: var(--ink);
  }
  .role[data-role="admin"] {
    color: var(--ink);
  }
</style>
