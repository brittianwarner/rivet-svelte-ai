<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import type { Member, Role } from "@example/entities/contracts";
  import {
    OrganizationViewModel,
    ago,
    clock,
    getConnections,
    getPrincipal,
    getUser,
    until,
  } from "#lib/data/index.js";
  import ActivityList from "./ActivityList.svelte";
  import ActorMeta from "./ActorMeta.svelte";
  import Avatar from "./Avatar.svelte";
  import EntityState from "./EntityState.svelte";
  import InlineRename from "./InlineRename.svelte";
  import RoleBadge from "./RoleBadge.svelte";

  let { orgId }: { orgId: string } = $props();

  // The route keys this component on orgId, so it is fixed for its life.
  // svelte-ignore state_referenced_locally
  const org = new OrganizationViewModel(orgId);
  const user = getUser();
  const principal = getPrincipal();
  const connections = getConnections();

  $effect(() => org.connect());
  $effect(() => connections.track(`organization/${org.orgId}`, org));

  const TABS = ["members", "projects", "invitations", "activity"] as const;
  type Tab = (typeof TABS)[number];
  const tab = $derived.by((): Tab => {
    const value = page.url.searchParams.get("tab");
    return TABS.includes(value as Tab) ? (value as Tab) : "members";
  });

  function tabHref(next: Tab): string {
    const base = resolve("/data/orgs/[orgId]", { orgId: org.orgId });
    return next === "members" ? base : `${base}?tab=${next}`;
  }

  const removed = $derived(user.lostAccess(org.orgId));

  const counts = $derived({
    members: org.members.length,
    projects: org.projects.length,
    invitations: org.invitations.length,
    activity: org.activity.length,
  });

  let inviteUser = $state("");
  // The person's pick, kept only while they may still grant it.
  let roleChoice = $state<Role | null>(null);
  const inviteRole = $derived.by((): Role => {
    const roles = org.grantableRoles;
    if (roleChoice && roles.includes(roleChoice)) return roleChoice;
    return roles.includes("member") ? "member" : (roles[0] ?? "viewer");
  });
  let projectName = $state("");

  const invitable = $derived(
    principal.personas.filter(
      (persona) =>
        !org.members.some((member) => member.userId === persona.sub) &&
        !org.invitations.some((invite) => invite.userId === persona.sub),
    ),
  );

  async function invite(event: SubmitEvent) {
    event.preventDefault();
    const userId = inviteUser.trim().toLowerCase();
    if (!userId) return;
    const done = await org.invite(userId, inviteRole);
    // Keep anything typed while the invite was in flight.
    if (done && inviteUser.trim().toLowerCase() === userId) inviteUser = "";
  }

  async function createProject(event: SubmitEvent) {
    event.preventDefault();
    const name = projectName.trim();
    if (!name) return;
    const projectId = await org.createProject(name);
    if (!projectId) return;
    if (projectName.trim() === name) projectName = "";
    await goto(
      resolve("/data/orgs/[orgId]/projects/[projectId]", {
        orgId: org.orgId,
        projectId,
      }),
    );
  }

  /** The project waiting on a second click to delete. */
  let confirming = $state<string | null>(null);

  async function deleteProject(projectId: string) {
    const done = await org.deleteProject(projectId);
    if (done) confirming = null;
  }

  /**
   * A refused change leaves the select showing the role that was not saved.
   * Put it back: the actor's answer is the truth.
   */
  async function changeRole(member: Member, select: HTMLSelectElement) {
    const done = await org.changeRole(member.userId, select.value as Role);
    if (!done) select.value = member.role;
  }

  async function leave(member: Member) {
    const result = await org.remove(member.userId);
    if (result === null) await goto(resolve("/data"));
  }
</script>

{#if removed}
  <div class="notice" role="alert">
    <h2>
      You are no longer a member of {org.snapshot?.name ?? "this organization"}.
    </h2>
    <a class="inline-link" href={resolve("/data")}>Back to overview</a>
  </div>
{:else if org.view !== "ready" || !org.snapshot}
  <EntityState
    view={org.view}
    noun="organization"
    error={org.error}
    onretry={() => org.reconnect()}
  />
{:else}
  {@const snapshot = org.snapshot}
  <header class="page-header">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href={resolve("/data")}>Overview</a><span aria-hidden="true">/</span
      ><span>Organization</span>
    </nav>
    <InlineRename
      value={snapshot.name}
      label="Organization name"
      editable={org.can("org.rename") && org.connected}
      busy={org.isBusy("rename")}
      onsave={(name) => org.rename(name)}
    />
    <div class="header-row">
      <ActorMeta
        actorKey={org.key}
        revision={snapshot.revision}
        updatedAt={snapshot.updatedAt}
        connStatus={org.connStatus}
      />
      {#if org.myRole}
        <span class="you">You are <RoleBadge role={org.myRole} /></span>
      {/if}
    </div>
    {#if snapshot.pendingSync.length > 0}
      <p class="sync" role="status">
        Updating {snapshot.pendingSync.length === 1
          ? "1 member's account"
          : `${snapshot.pendingSync.length} members' accounts`}. Retries run on
        their own.
      </p>
    {/if}
  </header>

  {#if org.error}
    <p class="error" role="alert">{org.error}</p>
  {/if}

  <nav class="tabs" aria-label="Organization data">
    {#each TABS as name (name)}
      <a
        href={tabHref(name)}
        aria-current={tab === name ? "page" : undefined}
        data-sveltekit-noscroll
        data-sveltekit-replacestate
        data-sveltekit-keepfocus
      >
        {name}<span class="tally">{counts[name]}</span>
      </a>
    {/each}
  </nav>

  <section class="panel" aria-label={tab}>
    {#if tab === "members"}
      {#if org.can("member.invite")}
        <form class="inline-form" onsubmit={invite}>
          <label class="sr-only" for="invite-user">User id</label>
          <input
            id="invite-user"
            list="invite-people"
            bind:value={inviteUser}
            placeholder="User id, such as grace"
            autocomplete="off"
            maxlength="48"
          />
          <datalist id="invite-people">
            {#each invitable as persona (persona.sub)}
              <option value={persona.sub}>{persona.name}</option>
            {/each}
          </datalist>
          <label class="sr-only" for="invite-role">Role</label>
          <select
            id="invite-role"
            value={inviteRole}
            onchange={(event) =>
              (roleChoice = event.currentTarget.value as Role)}
          >
            {#each org.grantableRoles as role (role)}
              <option value={role}>{role}</option>
            {/each}
          </select>
          <button
            type="submit"
            disabled={!inviteUser.trim() || org.isBusy("invite")}
            >{org.isBusy("invite") ? "Inviting…" : "Invite"}</button
          >
        </form>
      {/if}
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col">Role</th>
            <th scope="col">Joined</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each org.members as member (member.userId)}
            {@const busy = org.isBusy(`member:${member.userId}`)}
            {@const self = member.userId === principal.current?.sub}
            <tr>
              <td>
                <span class="person">
                  <Avatar id={member.userId} name={member.name} />
                  <span>
                    <strong>{member.name}{self ? " (you)" : ""}</strong>
                    <code>{member.userId}</code>
                  </span>
                </span>
              </td>
              <td>
                {#if org.canManage(member)}
                  <label class="sr-only" for={`role-${member.userId}`}
                    >Role for {member.name}</label
                  >
                  <select
                    id={`role-${member.userId}`}
                    value={member.role}
                    disabled={busy}
                    onchange={(event) =>
                      void changeRole(member, event.currentTarget)}
                  >
                    {#each org.grantableRoles.includes(member.role) ? org.grantableRoles : [member.role, ...org.grantableRoles] as role (role)}
                      <option value={role}>{role}</option>
                    {/each}
                  </select>
                {:else}
                  <RoleBadge role={member.role} />
                {/if}
              </td>
              <td class="muted">{ago(member.joinedAt, clock.now)}</td>
              <td class="actions">
                {#if self && member.role !== "owner"}
                  <button
                    type="button"
                    class="text-button"
                    disabled={busy}
                    onclick={() => void leave(member)}>Leave</button
                  >
                {/if}
                {#if org.myRole === "owner" && !self}
                  <button
                    type="button"
                    class="text-button"
                    disabled={busy}
                    onclick={() => void org.transfer(member.userId)}
                    >Make owner</button
                  >
                {/if}
                {#if org.canManage(member)}
                  <button
                    type="button"
                    class="text-button"
                    disabled={busy}
                    onclick={() => void org.remove(member.userId)}
                    >Remove</button
                  >
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if tab === "projects"}
      {#if org.can("project.write")}
        <form class="inline-form" onsubmit={createProject}>
          <label class="sr-only" for="project-name">Project name</label>
          <input
            id="project-name"
            bind:value={projectName}
            placeholder="Project name"
            autocomplete="off"
            maxlength="64"
          />
          <button
            type="submit"
            disabled={!projectName.trim() || org.isBusy("create-project")}
            >{org.isBusy("create-project")
              ? "Starting…"
              : "New project"}</button
          >
        </form>
      {/if}
      {#if org.projects.length === 0}
        <p class="empty">No projects yet.</p>
      {:else}
        <ul class="cards">
          {#each org.projects as link (link.projectId)}
            {@const busy = org.isBusy(`project:${link.projectId}`)}
            <li>
              <a
                class="card"
                href={resolve("/data/orgs/[orgId]/projects/[projectId]", {
                  orgId: org.orgId,
                  projectId: link.projectId,
                })}
              >
                <strong>{link.name}</strong>
                <code>{link.projectId}</code>
                <span class="muted"
                  >Started by {link.createdBy} · {ago(
                    link.createdAt,
                    clock.now,
                  )}</span
                >
              </a>
              {#if org.can("project.delete")}
                <div class="card-actions">
                  {#if confirming === link.projectId}
                    <span class="confirm" role="alert"
                      >Delete {link.name} and its tasks?</span
                    >
                    <button
                      type="button"
                      class="text-button danger"
                      disabled={busy}
                      onclick={() => void deleteProject(link.projectId)}
                      >{busy ? "Deleting…" : "Delete"}</button
                    >
                    <button
                      type="button"
                      class="text-button"
                      disabled={busy}
                      onclick={() => (confirming = null)}>Cancel</button
                    >
                  {:else}
                    <button
                      type="button"
                      class="text-button"
                      aria-label={`Delete ${link.name}`}
                      onclick={() => (confirming = link.projectId)}
                      >Delete</button
                    >
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:else if tab === "invitations"}
      {#if org.invitations.length === 0}
        <p class="empty">No open invitations.</p>
      {:else}
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Invitee</th>
              <th scope="col">Role</th>
              <th scope="col">Invited by</th>
              <th scope="col">Expires</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each org.invitations as invite (invite.inviteId)}
              <tr>
                <td><code>{invite.userId}</code></td>
                <td><RoleBadge role={invite.role} /></td>
                <td><code>{invite.invitedBy}</code></td>
                <td class="muted">{until(invite.expiresAt, clock.now)}</td>
                <td class="actions">
                  {#if org.can("member.invite")}
                    <button
                      type="button"
                      class="text-button"
                      disabled={org.isBusy(`revoke:${invite.inviteId}`)}
                      onclick={() => void org.revoke(invite.inviteId)}
                      >Revoke</button
                    >
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else}
      <ActivityList
        entries={org.activity}
        more={org.hasOlderActivity}
        loading={org.isBusy("history")}
        onmore={() => void org.showOlderActivity()}
      />
    {/if}
  </section>
{/if}

<style>
  .page-header {
    display: grid;
    gap: 12px;
    margin-bottom: 32px;
  }
  .crumbs {
    display: flex;
    gap: 8px;
    color: var(--muted);
    font-size: 13px;
  }
  .crumbs a:hover {
    color: var(--red);
  }
  .header-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 24px;
    align-items: center;
  }
  .you {
    color: var(--muted);
    font-size: 12px;
  }
  .sync {
    color: var(--muted);
    font-size: 13px;
  }
  .tabs {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    border-bottom: 1px solid var(--line);
  }
  .tabs a {
    display: inline-flex;
    gap: 8px;
    align-items: baseline;
    margin-bottom: -1px;
    border-bottom: 2px solid transparent;
    padding: 10px 14px;
    color: var(--muted);
    font-size: 14px;
    text-transform: capitalize;
    white-space: nowrap;
  }
  .tabs a:hover {
    color: var(--ink);
  }
  .tabs a[aria-current="page"] {
    border-bottom-color: var(--red);
    color: var(--ink);
    font-weight: 700;
  }
  .tally {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 400;
  }
  .panel {
    display: grid;
    gap: 16px;
    padding-top: 20px;
  }
  .inline-form {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    max-width: 640px;
  }
  .inline-form input {
    flex: 1 1 220px;
  }
  select {
    min-height: 36px;
    border: 1px solid var(--line);
    border-radius: 0;
    padding: 6px 8px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
  }
  .inline-form select {
    min-height: 44px;
  }
  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  th {
    border-bottom: 1px solid var(--ink);
    padding: 8px 12px 8px 0;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.08em;
    text-align: left;
    text-transform: uppercase;
  }
  td {
    border-bottom: 1px solid var(--line);
    padding: 10px 12px 10px 0;
    vertical-align: middle;
  }
  .person {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .person > span {
    display: grid;
  }
  code {
    font-family: var(--mono);
    font-size: 12px;
  }
  .person code {
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
  }
  .actions {
    text-align: right;
    white-space: nowrap;
  }
  .actions button {
    min-height: 32px;
    font-size: 12px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cards li {
    display: grid;
    grid-template-rows: 1fr auto;
    border: 1px solid var(--line);
  }
  .cards li:hover {
    border-color: var(--ink);
  }
  .card {
    display: grid;
    gap: 4px;
    height: 100%;
    padding: 16px;
    font-size: 13px;
  }
  .card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    border-top: 1px solid var(--line);
    padding: 4px 8px;
  }
  .card-actions button {
    min-height: 32px;
    font-size: 12px;
  }
  .confirm {
    flex: 1 1 100%;
    padding: 4px 8px 0;
    font-size: 12px;
  }
  button.danger {
    color: #a83222;
  }
  .card strong {
    font-size: 16px;
  }
  .card code {
    color: var(--muted);
  }
  .empty {
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
  @media (max-width: 640px) {
    .table thead {
      display: none;
    }
    .table tr {
      display: grid;
      grid-template-columns: 1fr auto;
      border-bottom: 1px solid var(--line);
      padding: 8px 0;
    }
    .table td {
      border: 0;
      padding: 4px 0;
    }
  }
</style>
