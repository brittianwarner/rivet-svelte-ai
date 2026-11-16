<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { ago, clock, getUser, until } from "#lib/data/index.js";
  import ActorMeta from "#lib/components/data/ActorMeta.svelte";
  import EntityState from "#lib/components/data/EntityState.svelte";
  import InlineRename from "#lib/components/data/InlineRename.svelte";
  import RoleBadge from "#lib/components/data/RoleBadge.svelte";

  const user = getUser();
  let orgName = $state("");

  async function createOrganization(event: SubmitEvent) {
    event.preventDefault();
    const name = orgName.trim();
    if (!name) return;
    const orgId = await user.createOrganization(name);
    if (!orgId) return;
    if (orgName.trim() === name) orgName = "";
    await goto(resolve("/data/orgs/[orgId]", { orgId }));
  }
</script>

{#if user.view !== "ready" || !user.snapshot}
  <EntityState
    view={user.view}
    noun="account"
    error={user.error}
    onretry={() => user.reconnect()}
  />
{:else}
  {@const snapshot = user.snapshot}
  <header class="page-header">
    <p class="eyebrow">ACCOUNT</p>
    <InlineRename
      value={snapshot.profile.name}
      label="Display name"
      editable={user.connected}
      busy={user.isBusy("rename")}
      onsave={(name: string) => user.rename(name)}
    />
    <ActorMeta
      actorKey={user.key}
      revision={snapshot.revision}
      updatedAt={snapshot.updatedAt}
      connStatus={user.connStatus}
    />
  </header>

  <div class="grid">
    <section class="block" aria-labelledby="inbox-title">
      <div class="block-heading">
        <h2 id="inbox-title">Invitations</h2>
        <span class="tally">{snapshot.inbox.length}</span>
      </div>
      {#if snapshot.inbox.length === 0}
        <p class="empty">No invitations waiting.</p>
      {:else}
        <ul class="rows">
          {#each snapshot.inbox as notice (notice.inviteId)}
            {@const busy = user.isBusy(`invite:${notice.inviteId}`)}
            <li class="row invite">
              <div>
                <strong>{notice.orgName}</strong>
                <span class="sub"
                  >From <code>{notice.invitedBy}</code> as
                  <RoleBadge role={notice.role} /> · expires {until(
                    notice.expiresAt,
                    clock.now,
                  )}</span
                >
              </div>
              <div class="row-actions">
                <button
                  type="button"
                  disabled={busy || !user.connected}
                  onclick={() => void user.respond(notice, true)}>Accept</button
                >
                <button
                  type="button"
                  class="secondary"
                  disabled={busy || !user.connected}
                  onclick={() => void user.respond(notice, false)}
                  >Decline</button
                >
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="block" aria-labelledby="orgs-title">
      <div class="block-heading">
        <h2 id="orgs-title">Organizations</h2>
        <span class="tally">{snapshot.organizations.length}</span>
      </div>
      {#if snapshot.organizations.length === 0}
        <p class="empty">
          You are not in an organization yet. Start one below.
        </p>
      {:else}
        <ul class="rows">
          {#each snapshot.organizations as link (link.orgId)}
            <li>
              <a
                class="row org-link"
                href={resolve("/data/orgs/[orgId]", { orgId: link.orgId })}
              >
                <span>
                  <strong>{link.name}</strong>
                  <code class="sub">{link.orgId}</code>
                </span>
                <RoleBadge role={link.role} />
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="block" id="new-org" aria-labelledby="new-org-title">
      <div class="block-heading">
        <h2 id="new-org-title">New organization</h2>
      </div>
      <p class="hint">
        You become its owner. The organization actor is created on first use.
      </p>
      <form class="inline-form" onsubmit={createOrganization}>
        <label class="sr-only" for="org-name">Organization name</label>
        <input
          id="org-name"
          bind:value={orgName}
          placeholder="Organization name"
          maxlength="64"
          autocomplete="off"
        />
        <button
          type="submit"
          disabled={!orgName.trim() || user.isBusy("create-org")}
        >
          {user.isBusy("create-org") ? "Creating…" : "Create"}
        </button>
      </form>
    </section>

    <section class="block" aria-labelledby="profile-title">
      <div class="block-heading">
        <h2 id="profile-title">Profile</h2>
      </div>
      <dl class="facts">
        <div>
          <dt>User id</dt>
          <dd><code>{snapshot.id}</code></dd>
        </div>
        <div>
          <dt>Theme</dt>
          <dd>{snapshot.preferences.theme}</dd>
        </div>
        <div>
          <dt>Joined</dt>
          <dd>{ago(snapshot.createdAt, clock.now)}</dd>
        </div>
      </dl>
    </section>
  </div>
{/if}

<style>
  .page-header {
    display: grid;
    gap: 12px;
    margin-bottom: 40px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
    gap: 24px;
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
  .rows {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--line);
    padding: 10px 0;
  }
  .row > div,
  .row > span {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .org-link:hover strong {
    color: var(--red);
  }
  .sub {
    color: var(--muted);
    font-size: 12px;
  }
  code {
    font-family: var(--mono);
  }
  .row-actions {
    display: flex !important;
    gap: 6px;
  }
  .row-actions button {
    min-height: 36px;
    padding: 6px 12px;
  }
  .empty,
  .hint {
    color: var(--muted);
    font-size: 14px;
  }
  .inline-form {
    display: flex;
    gap: 8px;
  }
  .facts {
    display: grid;
    gap: 8px;
    margin: 0;
  }
  .facts div {
    display: flex;
    justify-content: space-between;
    border-bottom: 1px solid var(--line);
    padding-bottom: 8px;
    font-size: 14px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
</style>
