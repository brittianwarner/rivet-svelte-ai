<script lang="ts">
  import DemoLoader from "#lib/components/DemoLoader.svelte";

  const actorExample = `export const counter = actor({
  state: { count: 0 },
  events: { changed: event<number>() },
  actions: {
    increment: (c) => {
      c.state.count += 1;
      c.broadcast("changed", c.state.count);
      return c.state.count;
    },
  },
});`;
  const steps = [
    {
      number: "01",
      title: "Install once",
      text: "Use this repository as your template. Node 26 and Bun 1.4.4 are all you need.",
      command: "bun install",
    },
    {
      number: "02",
      title: "Start locally",
      text: "One command starts SvelteKit, the API, and a local Rivet engine. No cloud account needed.",
      command: "bun run dev",
    },
    {
      number: "03",
      title: "Make it yours",
      text: "Edit the counter actor, then watch its types flow all the way to your Svelte components.",
      command: "apps/api/src/actors/counter.ts",
    },
  ];
</script>

<a class="skip-link" href="#main">Skip to content</a>
<div class="site-shell">
  <header class="site-header">
    <a class="wordmark" href="/" aria-label="Rivet and SvelteKit home"
      ><span class="brand-mark" aria-hidden="true">r.</span> rivet
      <span class="brand-plus">+</span>
      <span class="svelte-word">sveltekit</span></a
    >
    <nav aria-label="Main navigation">
      <a href="#playground">Playground</a>
      <a href="#start">Quickstart</a>
      <a
        class="nav-github"
        href="https://github.com/brittianwarner/rivet-svelte-ai"
        >GitHub <span aria-hidden="true">↗</span></a
      >
    </nav>
  </header>

  <main id="main">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <div class="release">
          <span class="status-dot"></span> RIVET 3.0.1
          <span class="release-divider">/</span> SVELTE 5
        </div>
        <h1 id="hero-title">Build something<br /><span>stateful.</span></h1>
        <p class="hero-description">
          Your frontend is reactive.<br />Your backend should be, too.
        </p>
        <p class="hero-detail">
          A practical starting point for realtime apps and AI conversations.
          Typed actors, persistent state, and SvelteKit — wired together and
          ready to make your own.
        </p>
        <div class="hero-actions">
          <a class="button" href="#start"
            >Start building <span aria-hidden="true">↗</span></a
          ><a class="text-link" href="#playground"
            >Try the playground <span aria-hidden="true">↓</span></a
          >
        </div>
        <p class="hero-note">
          Runs locally. No account required. AI is optional.
        </p>
      </div>
      <div class="code-window">
        <div class="code-title">
          <span><span class="code-dot"></span> actors/counter.ts</span><span
            >TypeScript</span
          >
        </div>
        <pre><code>{actorExample}</code></pre>
        <div class="code-caption">
          <span class="status-dot"></span> One actor. Its own state. Every connected
          client.
        </div>
      </div>
    </section>

    <div class="feature-strip" aria-label="Included technologies">
      <span>Rivet actors</span><span>Svelte 5 runes</span><span
        >SvelteKit SSR</span
      ><span>End-to-end types</span><span>Streaming AI</span>
    </div>

    <section
      id="playground"
      class="content-section"
      aria-labelledby="playground-title"
    >
      <div class="section-heading">
        <div>
          <p class="eyebrow">LEARN BY CHANGING THINGS</p>
          <h2 id="playground-title">Small examples. Real connections.</h2>
        </div>
        <p>
          Open a second tab. Increment the same counter.<br />That’s your first
          realtime app.
        </p>
      </div>
      <DemoLoader />
    </section>

    <section id="start" class="content-section" aria-labelledby="start-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">FROM CLONE TO CONNECTED</p>
          <h2 id="start-title">Your first actor in minutes.</h2>
        </div>
        <a
          class="text-link"
          href="https://github.com/brittianwarner/rivet-svelte-ai#readme"
          >Read the full guide ↗</a
        >
      </div>
      <div class="steps">
        {#each steps as step (step.number)}<article class="step">
            <span class="step-number">{step.number}</span>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
            <code>{step.command}</code>
          </article>{/each}
      </div>
    </section>

    <section
      class="architecture content-section"
      aria-labelledby="architecture-title"
    >
      <div>
        <p class="eyebrow">A PLACE FOR EVERYTHING</p>
        <h2 id="architecture-title">Simple to start.<br />Room to grow.</h2>
        <p>
          Give each room, document, or conversation its own actor. Keep the UI
          focused on rendering, and put the rules beside the state.
        </p>
        <a class="text-link" href="https://rivet.dev/actors/docs/"
          >Explore the actor model ↗</a
        >
      </div>
      <div class="file-map">
        <div>
          <code>apps/web</code><span
            >Pages, components, and reactive view models</span
          >
        </div>
        <div>
          <code>apps/api</code><span
            >Actors, business rules, and server-only AI</span
          >
        </div>
        <div>
          <code>packages/rivetkit-svelte</code><span
            >Typed connections, events, and lifecycle cleanup</span
          >
        </div>
        <div>
          <code>packages/wire</code><span
            >Shared contracts without server dependencies</span
          >
        </div>
      </div>
    </section>
  </main>
  <footer>
    <span>Built with Rivet + SvelteKit.</span>
    <div>
      <a href="https://rivet.dev/actors/docs/">Rivet docs ↗</a><a
        href="https://svelte.dev/docs/kit">SvelteKit docs ↗</a
      ><a href="https://github.com/brittianwarner/rivet-svelte-ai">Source ↗</a>
    </div>
  </footer>
</div>
