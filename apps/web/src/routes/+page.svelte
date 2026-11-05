<script lang="ts">
  import DemoLoader from "#lib/components/DemoLoader.svelte";

  const commands = [
    {
      name: "Clone the starter",
      code: "git clone https://github.com/brittianwarner/rivet-svelte-ai.git",
    },
    { name: "Install dependencies", code: "cd rivet-svelte-ai && bun install" },
    { name: "Start your app", code: "bun run dev" },
  ];
  const benefits = [
    {
      title: "State for every actor",
      text: "Give each counter, room, or session a key and a home for its state.",
    },
    {
      title: "Updates as they happen",
      text: "Send typed actions. Receive realtime events. Keep your interface in sync.",
    },
    {
      title: "Svelte from the start",
      text: "Svelte 5 components, runes, and SvelteKit routes are already connected to Rivet.",
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
      copyStatus =
        "Clipboard unavailable. Select the command to copy it manually.";
    }
  }
</script>

<a class="skip-link" href="#main">Skip to content</a>
<div class="site-shell">
  <header class="site-header">
    <a class="wordmark" href="/" aria-label="rivet + svelte home"
      >rivet<span>+</span>svelte<span class="brand-period">.</span></a
    >
    <nav aria-label="Main navigation">
      <a href="#playground">Playground</a>
      <a href="#start">Get started</a>
      <a href="https://github.com/brittianwarner/rivet-svelte-ai"
        >GitHub <span aria-hidden="true">↗</span></a
      >
    </nav>
  </header>
  <main id="main">
    <section class="hero" aria-labelledby="hero-title">
      <div>
        <p class="eyebrow">
          <span class="tiny-square"></span> RIVET ACTORS + SVELTEKIT
        </p>
        <h1 id="hero-title">Build apps that<br /><span>stay in sync.</span></h1>
      </div>
      <div class="hero-intro">
        <p class="hero-description">
          A SvelteKit starter with Rivet Actors for state and realtime updates.
          Svelte renders the interface; actors own the state. Start with a
          working app and make it yours.
        </p>
        <div class="hero-actions">
          <a class="button" href="#start"
            >Get the starter <span aria-hidden="true">↓</span></a
          ><a class="button hero-secondary" href="#playground"
            >Try the playground <span aria-hidden="true">↓</span></a
          >
        </div>
      </div>
    </section>
    <section id="playground" aria-labelledby="playground-title">
      <div class="playground-intro">
        <h2 id="playground-title">Live actor playground</h2>
        <p>Change a counter. Add an actor. Reload and find them here.</p>
      </div>
      <DemoLoader />
    </section>
    <section class="benefit-strip" aria-label="What you can build on">
      {#each benefits as benefit, index (benefit.title)}<article>
          <span class="benefit-number">0{index + 1}</span>
          <h3>{benefit.title}</h3>
          <p>{benefit.text}</p>
        </article>{/each}
    </section>
    <section id="start" class="start-section" aria-labelledby="start-title">
      <div class="start-copy">
        <p class="eyebrow">START LOCALLY</p>
        <h2 id="start-title">Make it yours.</h2>
        <p>
          Clone the starter, run it locally, then change an actor or build a new
          one. The counter, session, and Svelte examples are yours to adapt.
        </p>
        <div class="start-requirements">
          <span>Node 26</span><span>Bun 1.4.4</span>
        </div>
        <p class="start-local-note">
          No cloud account or API key required. After startup, open <a
            href="http://localhost:5173">localhost:5173</a
          >.
        </p>
        <a
          class="inline-link"
          href="https://github.com/brittianwarner/rivet-svelte-ai/blob/main/docs/first-actor.md"
          >Write your first actor <span aria-hidden="true">↗</span></a
        >
      </div>
      <div class="terminal">
        <div class="terminal-header">
          <span><i></i> QUICKSTART</span><span>~/your-next-thing</span>
        </div>
        {#each commands as command, i (command.name)}
          <div class="command-row">
            <div>
              <span class="command-number">0{i + 1}</span><span
                >{command.name}</span
              >
            </div>
            <div class="command-code">
              <code>{command.code}</code><button
                type="button"
                aria-label={`Copy ${command.name.toLowerCase()} command`}
                onclick={() => void copyCommand(command)}
                >{copied === command.name ? "Copied ✓" : "Copy"}</button
              >
            </div>
          </div>
        {/each}
        <p class="copy-feedback" role="status" aria-live="polite">
          {copyStatus}
        </p>
      </div>
    </section>
    <section class="resource-links" aria-label="Keep building">
      <a href="https://rivet.dev/actors/docs/"
        ><span class="resource-number">01</span><span
          ><strong>Rivet Actors docs</strong><small
            >Learn how keys, state, actions, and events fit together.</small
          ></span
        ><span aria-hidden="true">↗</span></a
      >
      <a href="https://svelte.dev/docs/svelte/overview"
        ><span class="resource-number">02</span><span
          ><strong>Svelte docs</strong><small
            >Build components with runes, reactivity, and lifecycle tools.</small
          ></span
        ><span aria-hidden="true">↗</span></a
      >
      <a href="https://github.com/brittianwarner/rivet-svelte-ai"
        ><span class="resource-number">03</span><span
          ><strong>Explore the source</strong><small
            >Follow the counter from its actor to the Svelte client.</small
          ></span
        ><span aria-hidden="true">↗</span></a
      >
    </section>
  </main>
  <footer>
    <span>An open-source starter for Rivet Actors and SvelteKit.</span>
    <a href="https://github.com/brittianwarner/rivet-svelte-ai"
      >Community-built <span aria-hidden="true">↗</span></a
    >
  </footer>
</div>
