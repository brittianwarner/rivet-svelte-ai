<script lang="ts">
  import { resolve } from "$app/paths";
  import { can, type ExportLink } from "@example/entities/contracts";
  import { SvelteSet } from "svelte/reactivity";
  import {
    ProjectViewModel,
    ago,
    clock,
    entityDeps,
    getConnections,
    getOrganization,
    getUser,
    until,
  } from "#lib/data/index.js";
  import ActivityList from "./ActivityList.svelte";
  import ActorMeta from "./ActorMeta.svelte";
  import Avatar from "./Avatar.svelte";
  import EntityState from "./EntityState.svelte";
  import InlineRename from "./InlineRename.svelte";
  import RoleBadge from "./RoleBadge.svelte";
  import Skeleton from "./Skeleton.svelte";
  import TaskThread from "./TaskThread.svelte";
  import { saveFile } from "./save-file.js";

  let { orgId, projectId }: { orgId: string; projectId: string } = $props();

  // The route keys this component on both ids.
  // svelte-ignore state_referenced_locally
  const project = new ProjectViewModel(orgId, projectId, entityDeps());
  const user = getUser();
  // The org layout keeps its socket open, and its index names this project.
  const org = getOrganization();
  const connections = getConnections();

  $effect(() => project.connect());
  $effect(() =>
    connections.track(`project/${project.orgId}/${project.projectId}`, project),
  );

  // The organization owns roles; the user mirror already carries this one.
  const link = $derived(
    user.organizations.find((item) => item.orgId === project.orgId) ?? null,
  );
  const writable = $derived(can(link?.role, "project.write"));
  const loading = $derived(project.view === "loading");
  const name = $derived(
    project.snapshot?.name ??
      org.projects.find((item) => item.projectId === project.projectId)?.name ??
      null,
  );
  const removed = $derived(user.lostAccess(project.orgId));
  const orgHref = $derived(
    resolve("/data/orgs/[orgId]", { orgId: project.orgId }),
  );

  let title = $state("");
  /** Threads this person opened. Page state only; the actor keeps comments. */
  const openThreads = new SvelteSet<string>();

  function toggleThread(taskId: string) {
    if (openThreads.has(taskId)) openThreads.delete(taskId);
    else openThreads.add(taskId);
  }

  async function download(link: ExportLink) {
    const file = await project.download(link);
    if (file) saveFile(file);
  }

  function exportLabel(link: ExportLink): string {
    switch (link.status) {
      case "queued":
        return "Queued";
      case "running":
        return "Building…";
      case "failed":
        return link.error ?? "Failed";
      case "ready":
        return `${link.rows ?? 0} rows · ${formatBytes(link.bytes ?? 0)} · expires ${until(link.expiresAt, clock.now)}`;
    }
  }

  function formatBytes(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  }

  async function addTask(event: SubmitEvent) {
    event.preventDefault();
    const next = title.trim();
    if (!next) return;
    const done = await project.addTask(next);
    // Keep anything typed while the task was being saved.
    if (done && title.trim() === next) title = "";
  }
</script>

{#if removed}
  <div class="notice" role="alert">
    <h2>You no longer have access to this project.</h2>
    <a class="inline-link" href={resolve("/data")}>Back to overview</a>
  </div>
{:else if !loading && (project.view !== "ready" || !project.snapshot)}
  <EntityState
    view={project.view}
    noun="project"
    error={project.error}
    onretry={() => project.reconnect()}
  />
{:else}
  {@const snapshot = project.snapshot}
  <header class="page-header" aria-busy={loading}>
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href={resolve("/data")}>Overview</a><span aria-hidden="true">/</span>
      <a href={orgHref}>{link?.name ?? project.orgId}</a><span
        aria-hidden="true">/</span
      >
      <a href={`${orgHref}?tab=projects`}>Projects</a>
    </nav>
    {#if name}
      <InlineRename
        value={name}
        label="Project name"
        editable={!!snapshot && writable && project.connected}
        busy={project.looksBusy("rename")}
        onsave={(next: string) => project.rename(next)}
      />
    {:else}
      <div class="title-skeleton">
        <Skeleton width="12ch" height="calc(clamp(28px, 4vw, 40px) * 1.1)" />
      </div>
    {/if}
    <div class="header-row">
      <ActorMeta
        actorKey={project.key}
        revision={snapshot?.revision}
        updatedAt={snapshot?.updatedAt}
        connStatus={project.connStatus}
      />
      {#if link}
        <span class="you">You are <RoleBadge role={link.role} /></span>
      {/if}
      {#if project.viewers.length > 0}
        <ul class="viewers" aria-label="Viewing now">
          {#each project.viewers as viewer (viewer.userId)}
            <li title={`${viewer.name} is viewing`}>
              <Avatar id={viewer.userId} name={viewer.name} size={24} />
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </header>

  {#if project.error}
    <p class="error" role="alert">{project.error}</p>
  {/if}

  <div class="layout">
    <section class="block" aria-labelledby="tasks-title">
      <div class="block-heading">
        <h2 id="tasks-title">Tasks</h2>
        <span class="tally"
          >{snapshot
            ? `${project.openCount} open · ${project.tasks.length - project.openCount} done`
            : ""}</span
        >
      </div>
      {#if !link}
        <div class="toolbar">
          <Skeleton width="100%" height="48px" />
        </div>
      {:else if writable}
        <form class="inline-form toolbar" onsubmit={addTask}>
          <label class="sr-only" for="task-title">New task</label>
          <input
            id="task-title"
            bind:value={title}
            placeholder="Add a task"
            autocomplete="off"
            maxlength="64"
          />
          <button
            type="submit"
            disabled={!title.trim() || project.looksBusy("add-task")}
            >{project.looksBusy("add-task") ? "Adding…" : "Add"}</button
          >
        </form>
      {:else}
        <p class="hint toolbar">
          Viewers can read tasks. Members can change them.
        </p>
      {/if}
      {#if !snapshot}
        <ul class="tasks" aria-hidden="true">
          {#each [0, 1, 2] as index (index)}
            <li>
              <div class="task"><Skeleton width="60%" height="22px" /></div>
            </li>
          {/each}
        </ul>
      {:else if project.tasks.length === 0}
        <p class="empty">No tasks yet.</p>
      {:else}
        <ul class="tasks">
          {#each project.tasks as task (task.taskId)}
            {@const open = openThreads.has(task.taskId)}
            <li data-done={task.done}>
              <div class="task">
                <label>
                  <input
                    type="checkbox"
                    checked={task.done}
                    disabled={!writable || !project.connected}
                    onchange={() => void project.toggle(task)}
                  />
                  <span class="task-title">{task.title}</span>
                </label>
                <span class="meta"
                  ><code>{task.createdBy}</code> · {ago(
                    task.createdAt,
                    clock.now,
                  )}</span
                >
                <span class="task-actions">
                  <button
                    type="button"
                    class="text-button"
                    aria-expanded={open}
                    aria-controls={`thread-${task.taskId}`}
                    onclick={() => toggleThread(task.taskId)}
                    >{task.comments === 1
                      ? "1 comment"
                      : `${task.comments} comments`}</button
                  >
                  {#if writable}
                    <button
                      type="button"
                      class="text-button"
                      aria-label={`Remove ${task.title}`}
                      disabled={!project.connected ||
                        project.looksBusy(`task:${task.taskId}`)}
                      onclick={() => void project.removeTask(task)}
                      >Remove</button
                    >
                  {/if}
                </span>
              </div>
              {#if open}
                <div id={`thread-${task.taskId}`}>
                  <TaskThread {project} taskId={task.taskId} {writable} />
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <div class="side">
      <section class="block" aria-labelledby="exports-title">
        <div class="block-heading">
          <h2 id="exports-title">Exports</h2>
          <button
            type="button"
            class="secondary"
            disabled={!project.connected ||
              project.exporting ||
              project.looksBusy("export")}
            onclick={() => void project.startExport()}
            >{project.exporting ? "Exporting…" : "Export CSV"}</button
          >
        </div>
        {#if !snapshot}
          <Skeleton width="80%" height="18px" />
        {:else if project.exports.length === 0}
          <p class="hint">
            Export the task list as a CSV file. Files are kept for a limited
            time.
          </p>
        {:else}
          <ul class="exports">
            {#each project.exports as link (link.exportId)}
              <li data-status={link.status}>
                <span>
                  <strong>{ago(link.createdAt, clock.now)}</strong>
                  <span class="meta"
                    >by <code>{link.requestedBy}</code> · {exportLabel(
                      link,
                    )}</span
                  >
                </span>
                {#if link.status === "ready"}
                  <button
                    type="button"
                    class="text-button"
                    disabled={project.looksBusy(`download:${link.exportId}`)}
                    onclick={() => void download(link)}
                    >{project.looksBusy(`download:${link.exportId}`)
                      ? "Downloading…"
                      : "Download"}</button
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="block" aria-labelledby="activity-title">
        <div class="block-heading">
          <h2 id="activity-title">Activity</h2>
        </div>
        {#if !snapshot}
          <div class="skeleton-lines" aria-hidden="true">
            {#each [0, 1, 2] as index (index)}
              <Skeleton width="100%" height="41px" />
            {/each}
          </div>
        {:else}
          <ActivityList
            entries={project.activity}
            more={project.hasOlderActivity}
            loading={project.looksBusy("history")}
            onmore={() => void project.showOlderActivity()}
          />
        {/if}
      </section>
    </div>
  </div>
{/if}

<style>
  .title-skeleton {
    display: flex;
  }
  /* The row above the task list keeps one height whatever it holds. */
  .toolbar {
    display: flex;
    align-items: center;
    /* The form's controls are 47.6px; one height for form, note and skeleton. */
    min-height: 48px;
    margin: 0;
  }
  .skeleton-lines {
    display: grid;
    gap: 1px;
  }
  .page-header {
    display: grid;
    gap: 12px;
    margin-bottom: 32px;
  }
  .crumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--muted);
    font-size: 13px;
  }
  .crumbs a:hover {
    color: var(--red);
  }
  .header-row {
    min-height: 24px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px 24px;
    align-items: center;
  }
  .you {
    color: var(--muted);
    font-size: 12px;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 32px;
  }
  .block {
    display: grid;
    align-content: start;
    gap: 12px;
    border-top: 1px solid var(--ink);
    padding-top: 12px;
  }
  .block-heading {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  h2 {
    font-size: 16px;
  }
  .tally {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 12px;
  }
  .inline-form {
    display: flex;
    gap: 8px;
  }
  .tasks {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tasks li {
    border-bottom: 1px solid var(--line);
    padding: 8px 0;
  }
  .task {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    justify-content: space-between;
    align-items: center;
  }
  .task-actions {
    display: flex;
    gap: 4px;
  }
  .task-actions button {
    min-height: 32px;
    font-size: 12px;
  }
  .side {
    display: grid;
    align-content: start;
    gap: 32px;
  }
  .viewers {
    display: flex;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .viewers li + li {
    margin-left: -6px;
  }
  .exports {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .exports li {
    display: flex;
    gap: 12px;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--line);
    padding: 8px 0;
    font-size: 13px;
  }
  .exports li > span {
    display: grid;
    gap: 2px;
  }
  .exports li[data-status="failed"] .meta {
    color: #a83222;
  }
  .tasks label {
    display: flex;
    flex: 1;
    gap: 12px;
    align-items: center;
    min-height: 32px;
    cursor: pointer;
  }
  .tasks input {
    width: 18px;
    min-height: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--ink);
  }
  [data-done="true"] .task-title {
    color: var(--muted);
    text-decoration: line-through;
  }
  .meta {
    color: var(--muted);
    font-size: 12px;
  }
  code {
    font-family: var(--mono);
  }
  .empty,
  .hint {
    color: var(--muted);
    font-size: 14px;
  }
  .notice {
    display: grid;
    gap: 12px;
    padding: 32px 0;
  }
  .notice h2 {
    font-size: 22px;
  }
  @media (max-width: 900px) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
</style>
