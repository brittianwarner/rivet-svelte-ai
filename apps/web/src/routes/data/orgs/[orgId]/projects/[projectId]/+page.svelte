<script lang="ts">
  import { page } from "$app/state";
  import ProjectPage from "#lib/components/data/ProjectPage.svelte";
</script>

{#key `${page.params.orgId}/${page.params.projectId}`}
  <ProjectPage orgId={page.params.orgId!} projectId={page.params.projectId!} />
{/key}
