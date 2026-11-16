<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { getConnections, getPrincipal, getUser } from "#lib/data/index.js";
  import Avatar from "./Avatar.svelte";
  import RoleBadge from "./RoleBadge.svelte";

  let { children }: { children: Snippet } = $props();

  const principal = getPrincipal();
  const user = getUser();
  const connections = getConnections();
  const health = connections.health;

  const me = $derived(principal.current!);

  /** A failed switch leaves the select on someone else. Point it back. */
  async function switchPerson(select: HTMLSelectElement) {
    const done = await principal.signIn(select.value);
    if (!done && principal.current) select.value = principal.current.sub;
  }
  const displayName = $derived(user.snapshot?.profile.name ?? me.name);
  const activeOrg = $derived(page.params.orgId ?? null);
  const healthLabel = $derived(
    health.total === 0
      ? "No actors open"
      : health.status === "connected"
        ? `${health.connected} of ${health.total} actors live`
        : health.status === "connecting"
          ? "Connecting…"
          : `${health.connected} of ${health.total} live · reconnecting`,
  );
</script>

<div class="data-shell" data-theme={user.theme}>
  <a class="skip-link" href="#main">Skip to content</a>
  <aside class="sidebar" aria-label="Data navigation">
    <a class="brand" href={resolve("/")}>
      <span class="brand-mark" aria-hidden="true"></span>
      <span>svelte actors</span><span class="slash">/</span><span>data</span>
    </a>

    <section class="person" aria-label="Signed in">
      <div class="who">
        <Avatar id={me.sub} name={displayName} size={36} />
        <div>
          <strong>{displayName}</strong>
          <code>{me.sub}</code>
        </div>
      </div>
      <label class="switch">
        <span class="sr-only">Switch person</span>
        <select
          value={me.sub}
          disabled={principal.pending !== null}
          onchange={(event) => void switchPerson(event.currentTarget)}
        >
          {#each principal.personas as persona (persona.sub)}
            <option value={persona.sub}>Act as {persona.name}</option>
          {/each}
        </select>
      </label>
      {#if principal.error}
        <p class="error" role="alert">{principal.error}</p>
      {/if}
    </section>

    <nav aria-label="Entities">
      <a
        class="nav-item"
        href={resolve("/data")}
        aria-current={page.url.pathname === "/data" ? "page" : undefined}
      >
        <span>Overview</span>
        {#if user.inbox.length > 0}
          <span class="count" aria-label={`${user.inbox.length} invitations`}
            >{user.inbox.length}</span
          >
        {/if}
      </a>
      <p class="nav-heading">Organizations</p>
      {#if user.view === "loading"}
        <p class="nav-note">Loading…</p>
      {:else if user.organizations.length === 0}
        <p class="nav-note">None yet.</p>
      {:else}
        <ul>
          {#each user.organizations as link (link.orgId)}
            <li>
              <a
                class="nav-item"
                href={resolve("/data/orgs/[orgId]", { orgId: link.orgId })}
                aria-current={activeOrg === link.orgId ? "page" : undefined}
              >
                <span class="org-name">{link.name}</span>
                <RoleBadge role={link.role} />
              </a>
            </li>
          {/each}
        </ul>
      {/if}
      <a class="nav-new" href={`${resolve("/data")}#new-org`}
        >+ New organization</a
      >
    </nav>

    <footer class="sidebar-footer">
      <p class="health" data-status={health.status} role="status">
        <span aria-hidden="true"></span>{healthLabel}
      </p>
      <div class="footer-actions">
        <button
          type="button"
          class="text-button"
          disabled={!user.connected || user.isBusy("theme")}
          onclick={() =>
            void user.setTheme(user.theme === "dark" ? "light" : "dark")}
        >
          {user.theme === "dark" ? "Light theme" : "Dark theme"}
        </button>
        <button
          type="button"
          class="text-button"
          onclick={() => principal.signOut()}>Sign out</button
        >
      </div>
    </footer>
  </aside>

  <main id="main" tabindex="-1">
    {#if user.error}
      <p class="error banner" role="alert">{user.error}</p>
    {/if}
    {@render children()}
  </main>
</div>

<style>
  .data-shell {
    display: grid;
    grid-template-columns: minmax(240px, 272px) minmax(0, 1fr);
    min-height: 100vh;
    background: var(--paper);
    color: var(--ink);
  }
  .data-shell[data-theme="dark"] {
    --paper: #121412;
    --ink: #e9ebe6;
    --muted: #9aa197;
    --line: #2d322c;
    --surface: #1b1e1a;
    --surface-raised: #232722;
    --red: #e2694f;
    --green: #6fbf83;
    color-scheme: dark;
  }
  .sidebar {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 24px;
    height: 100vh;
    overflow-y: auto;
    border-right: 1px solid var(--line);
    padding: 24px 16px;
  }
  .brand {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 14px;
    font-weight: 700;
  }
  .slash {
    color: var(--muted);
    font-weight: 400;
  }
  .person {
    display: grid;
    gap: 10px;
    border: 1px solid var(--line);
    padding: 12px;
  }
  .who {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .who div {
    display: grid;
    min-width: 0;
  }
  .who strong {
    overflow: hidden;
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .who code {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
  }
  select {
    width: 100%;
    min-height: 36px;
    border: 1px solid var(--line);
    border-radius: 0;
    padding: 6px 8px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
  }
  nav {
    display: grid;
    gap: 2px;
  }
  nav ul {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .nav-item {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    min-height: 36px;
    border-left: 2px solid transparent;
    padding: 6px 10px;
    font-size: 14px;
  }
  .nav-item:hover {
    background: var(--surface);
  }
  .nav-item[aria-current="page"] {
    border-left-color: var(--red);
    background: var(--surface);
    font-weight: 700;
  }
  .org-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    min-width: 20px;
    background: var(--red);
    color: var(--paper);
    padding: 0 6px;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 18px;
    text-align: center;
  }
  .nav-heading {
    margin-top: 16px;
    padding: 0 12px 4px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .nav-note {
    padding: 4px 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .nav-new {
    margin-top: 6px;
    padding: 6px 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .nav-new:hover {
    color: var(--red);
  }
  .sidebar-footer {
    display: grid;
    gap: 8px;
    margin-top: auto;
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .health {
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--muted);
    font-size: 12px;
  }
  .health span {
    width: 7px;
    height: 7px;
    border: 1px solid var(--muted);
  }
  .health[data-status="connected"] span {
    border-color: var(--green);
    background: var(--green);
  }
  .health[data-status="degraded"] span,
  .health[data-status="offline"] span {
    border-color: var(--red);
  }
  .footer-actions {
    display: flex;
    gap: 4px;
    margin-left: -8px;
  }
  .footer-actions button {
    min-height: 32px;
    font-size: 12px;
  }
  main {
    min-width: 0;
    padding: 40px clamp(16px, 4vw, 56px) 64px;
  }
  main:focus {
    outline: none;
  }
  .banner {
    margin-bottom: 16px;
  }
  @media (max-width: 760px) {
    .data-shell {
      grid-template-columns: 1fr;
    }
    .sidebar {
      position: static;
      height: auto;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    .sidebar-footer {
      margin-top: 0;
    }
    main {
      padding-top: 24px;
    }
  }
</style>
