<script lang="ts">
  import { onMount } from "svelte";
  import ActorLab from "./ActorLab.svelte";
  import { SessionViewModel } from "#lib/view-models/session-view-model.svelte.js";

  const session = new SessionViewModel();
  onMount(() => session.connect());
</script>

<ActorLab {session} />
