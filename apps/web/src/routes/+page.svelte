<script lang="ts">
  import DemoLoader from "#lib/components/DemoLoader.svelte";

  const repository = "https://github.com/brittianwarner/rivet-svelte-ai";
  const commands = [
    {
      name: "Clone the starter",
      code: `git clone ${repository}.git`,
    },
    {
      name: "Install dependencies",
      code: "cd rivet-svelte-ai && bun install --frozen-lockfile",
    },
    { name: "Start your app", code: "bun run dev" },
  ];
  const boundaries = [
    {
      title: "The actor owns the count.",
      text: "A key identifies an independent counter. Its state belongs to that actor, beyond any one browser connection.",
    },
    {
      title: "The session keeps the keys.",
      text: "Your session remembers its collection. Removing a counter changes membership; it does not destroy the counter.",
    },
    {
      title: "Svelte renders the view.",
      text: "Actions, events, and snapshots update the view model. Svelte turns that reactive state into the interface you see.",
    },
  ];
  let copied = $state("");
  let copyStatus = $state("");

  async function copyCommand(command: (typeof commands)[number]) {
    try {
      await navigator.clipboard.writeText(command.code);
      copied = command.name;
      copyStatus = `${command.name}: command copied.`;
    } catch {
      copied = "";
      copyStatus =
        "Clipboard unavailable. Select the command to copy it manually.";
    }
  }
</script>

<a class="skip-link" href="#main">Skip to content</a>
<div class="site-shell">
  <header class="site-header">
    <a class="wordmark" href="/" aria-label="rivet + svelte home">
      <span class="brand-mark" aria-hidden="true"></span>
      <span>svelte actors</span>
    </a>
    <nav aria-label="Main navigation">
      <a class="learn-nav" href="#how">How it works</a>
      <a class="start-nav" href="#start"
        >Get started <span aria-hidden="true">↘</span></a
      >
      <a
        class="repo-nav"
        href={repository}
        aria-label="GitHub source repository"
      >
        <span class="repo-label">GitHub</span><span aria-hidden="true">↗</span>
      </a>
    </nav>
  </header>

  <main id="main" tabindex="-1">
    <div class="site-kicker">
      <p>
        <span aria-hidden="true"></span>rivet + svelte
        <span class="kicker-divider">/</span> community-built
      </p>
      <span class="kicker-note">Independent state. Live interfaces.</span>
    </div>
    <section id="playground" aria-label="Interactive actor playground">
      <DemoLoader />
    </section>

    <section id="how" class="boundary-section" aria-labelledby="boundary-title">
      <div class="section-heading">
        <span class="eyebrow">01 / THE OWNERSHIP MODEL</span>
        <h2 id="boundary-title">Small pieces. A working whole.</h2>
      </div>
      <div class="boundary-grid">
        {#each boundaries as boundary, index (boundary.title)}
          <article>
            <span class="boundary-number" aria-hidden="true">0{index + 1}</span>
            <h3>{boundary.title}</h3>
            <p>{boundary.text}</p>
          </article>
        {/each}
      </div>
    </section>

    <section id="start" class="start-section" aria-labelledby="start-title">
      <div class="start-copy">
        <p class="eyebrow">02 / MAKE IT YOURS</p>
        <h2 id="start-title">Small start.<br />Room to build.</h2>
        <p>
          A working app with independent counters, live components, and a
          session that remembers. Clone it, run it, then give your own idea a
          home.
        </p>
        <div class="start-requirements">
          <span>Node 26</span><span>Bun 1.4.4</span>
        </div>
        <p class="start-local-note">
          The local Rivet engine starts with the app. No account, Docker, or AI
          key needed for counters. Open <a href="http://127.0.0.1:5173"
            >127.0.0.1:5173</a
          > after startup.
        </p>
        <a
          class="inline-link"
          href={`${repository}/blob/main/docs/first-actor.md`}
        >
          Build your first actor <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div class="terminal" aria-label="Local quickstart commands">
        <div class="terminal-header">
          <span>YOUR NEXT THING</span><span>TERMINAL ↙</span>
        </div>
        {#each commands as command, index (command.name)}
          <div class="command-row">
            <div class="command-caption">
              <span class="command-number">0{index + 1}</span><span
                >{command.name}</span
              >
            </div>
            <div class="command-code">
              <code>{command.code}</code>
              <button
                type="button"
                aria-label={`Copy ${command.name.toLowerCase()} command`}
                onclick={() => void copyCommand(command)}
              >
                {copied === command.name ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        {/each}
        <p class="copy-feedback" role="status">
          {copyStatus || "Copy a command. Make it yours."}
        </p>
      </div>
    </section>

    <section class="resource-links" aria-label="Keep building">
      <a href="https://rivet.dev/actors/docs/"
        ><span
          ><strong>Rivet Actors docs</strong><small
            >Keys, state, actions, and events.</small
          ></span
        ><span aria-hidden="true">↗</span></a
      >
      <a href="https://svelte.dev/docs/svelte/overview"
        ><span
          ><strong>Svelte docs</strong><small
            >Components, runes, and reactivity.</small
          ></span
        ><span aria-hidden="true">↗</span></a
      >
      <a href={repository}
        ><span
          ><strong>Explore the source</strong><small
            >Follow the actor to its Svelte view.</small
          ></span
        ><span aria-hidden="true">↗</span></a
      >
    </section>
  </main>
  <footer class="site-footer">
    <a href={repository}>rivet + svelte <span aria-hidden="true">↗</span></a>
    <p>
      Community-built starter. Workspace Svelte adapter, not an official Rivet
      SDK.
    </p>
  </footer>
</div>
