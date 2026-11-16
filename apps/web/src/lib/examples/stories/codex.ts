import type { ExampleStory } from "../types";

const first =
  "Write fib.py that prints the first 10 Fibonacci numbers, then run it.";
const followUp = "Make it print 20 numbers and run it again.";
const base =
  "codex exec --json --skip-git-repo-check --sandbox danger-full-access";

export const codex: ExampleStory = {
  slug: "codex",
  section: "coding-agents",
  title: "Codex",
  tagline:
    "Run the Codex CLI for each user in a cloud sandbox that keeps the same thread across prompts and visits.",
  ideas: [
    "codex exec --json prints one event per line; the actor broadcasts each one.",
    "The first event, thread.started, names the thread that exec resume continues.",
    "The cloud sandbox is the boundary, so Codex's own sandbox is turned off.",
  ],
  docs: "https://rivet.dev/guides/run-codex/",
  requires: [
    {
      label: "@rivet-dev/sandbox-adapter",
      detail:
        "create, connect, exec, and e2bProvider. The guide pins no version.",
    },
    { label: "e2b", detail: "E2B's SDK, used by the E2B provider." },
    {
      label: "rivetkit",
      detail: "actor, event, vars, and actionTimeout. This repo pins 3.0.1.",
    },
    {
      label: "E2B_API_KEY",
      detail: "Stays on the worker. It never enters the sandbox.",
    },
    {
      label: "CODEX_API_KEY",
      detail:
        "An OpenAI key, passed to one exec only. Commands Codex runs can read it, so use a key with a spending limit.",
    },
    {
      label: "Authentication",
      detail:
        "Any client that knows a session id can prompt it. Protect the actor in production.",
    },
    {
      label: "Provider",
      detail:
        "E2B streams output. Daytona sends it all at exit. Freestyle needs a firewall rule that allows HTTPS out.",
    },
  ],
  nodes: [
    { id: "app", label: "Your app", kind: "client", x: 14, y: 30 },
    {
      id: "session",
      label: "codexSession",
      kind: "actor",
      key: '["session-123"]',
      x: 44,
      y: 30,
    },
    {
      id: "state",
      label: "state",
      kind: "store",
      key: "sandboxId · thread id",
      x: 44,
      y: 50,
    },
    {
      id: "sandbox",
      label: "E2B sandbox",
      kind: "sandbox",
      key: "~/.local/bin/codex",
      x: 76,
      y: 18,
    },
    { id: "api", label: "OpenAI API", kind: "service", x: 76, y: 46 },
  ],
  edges: [
    { id: "app-session", from: "app", to: "session" },
    { id: "session-state", from: "session", to: "state", dashed: true },
    { id: "session-sandbox", from: "session", to: "sandbox" },
    { id: "sandbox-api", from: "sandbox", to: "api" },
  ],
  beats: [
    {
      title: "One actor per session.",
      body: "Your app connects to codexSession with your session id and sends a prompt. The actor keeps the transcript, the sandbox id, and Codex's thread id.",
      enter: ["app", "session", "state"],
      focus: ["session"],
      status: { session: "prompt" },
      flows: [{ edge: "app-session", label: "prompt(text)" }],
      panel: {
        kind: "terminal",
        title: "client.ts",
        lines: [
          { text: "npx tsx client.ts", tone: "command" },
          {
            text: 'client.codexSession.getOrCreate(["session-123"]).connect()',
            tone: "muted",
          },
          { text: `session.prompt("${first}")`, tone: "event" },
        ],
      },
    },
    {
      title: "Create the sandbox, install Codex.",
      body: "No sandbox id is stored, so the actor creates one and saves the id. The standalone installer puts Codex in ~/.local/bin, and later connects skip the download.",
      enter: ["sandbox"],
      focus: ["session", "sandbox"],
      status: { session: "opening", sandbox: "installing" },
      flows: [
        { edge: "session-sandbox", label: "provider.create(c)" },
        { edge: "session-state", label: "save sandboxId" },
      ],
      panel: {
        kind: "terminal",
        title: "sandbox",
        lines: [
          {
            text: "test -x $HOME/.local/bin/codex || (curl -fsSL https://chatgpt.com/codex/install.sh | sh)",
            tone: "command",
          },
          {
            text: "skipped when ~/.local/bin/codex already exists",
            tone: "muted",
          },
          { text: "exit 0", tone: "ok" },
        ],
      },
    },
    {
      title: "Three flags make it headless.",
      body: "codex exec runs one prompt and exits. The home directory is not a Git repository, and codex exec is read-only by default, so two flags clear the way. The E2B sandbox is the boundary.",
      focus: ["sandbox"],
      status: { session: "opening", sandbox: "ready" },
      panel: {
        kind: "state",
        title: "codex exec flags",
        rows: [
          ["--json", "one JSON event per line"],
          ["--skip-git-repo-check", "work outside a Git repository"],
          [
            "--sandbox danger-full-access",
            "allow writes and network, e.g. npm install",
          ],
          ["CODEX_API_KEY", "in this exec's env only"],
        ],
      },
    },
    {
      title: "Events stream as output.",
      body: "onData receives output as the sandbox reports it. Each JSON line is broadcast to connected clients right away, so your app shows commands and messages while Codex works.",
      enter: ["api"],
      focus: ["sandbox", "api", "app"],
      status: { session: "streaming", sandbox: "running" },
      flows: [
        { edge: "session-sandbox", label: "exec(command)" },
        { edge: "sandbox-api", label: "model calls" },
        { edge: "app-session", label: "output", back: true },
      ],
      panel: {
        kind: "terminal",
        title: "output events",
        lines: [
          { text: `${base} '${first}'`, tone: "command" },
          {
            text: '{"type":"thread.started","thread_id":"0199a2…"}',
            tone: "event",
          },
          {
            text: '{"type":"item.completed","item":{"type":"command_execution",…}}',
            tone: "event",
          },
          {
            text: '{"type":"item.completed","item":{"type":"agent_message","text":"fib.py prints 0 1 1 2 3 5 8 13 21 34."}}',
            tone: "ok",
          },
        ],
      },
    },
    {
      title: "The thread id comes first.",
      body: "readEvent takes the thread id from thread.started and the answer from the last finished agent message. The turn is saved only after Codex exits cleanly.",
      focus: ["session", "state"],
      status: { session: "saved", sandbox: "idle" },
      flows: [
        { edge: "session-state", label: "save thread id" },
        { edge: "app-session", label: "answer", back: true },
      ],
      panel: {
        kind: "state",
        title: "codexSession state",
        rows: [
          ["sandboxId", "saved on create"],
          ["cliSessionId", "0199a2… (thread.started)"],
          ["transcript", "1 user + 1 assistant"],
          ["vars.running", "false (not saved)"],
        ],
      },
    },
    {
      title: "exec resume continues it.",
      body: 'The follow-up adds resume and the thread id after the flags. Codex keeps its sessions under ~/.codex in the sandbox, so "it" still means fib.py.',
      focus: ["session", "sandbox"],
      status: { session: "streaming", sandbox: "same thread" },
      flows: [
        { edge: "app-session", label: "prompt(text)" },
        { edge: "session-sandbox", label: "exec(resume)" },
        { edge: "sandbox-api", label: "model calls" },
      ],
      panel: {
        kind: "terminal",
        title: "output events",
        lines: [
          { text: `${base} resume '0199a2…' '${followUp}'`, tone: "command" },
          {
            text: '{"type":"item.completed","item":{"type":"command_execution",…}}',
            tone: "event",
          },
          {
            text: '{"type":"item.completed","item":{"type":"agent_message","text":"fib.py now prints 20 numbers."}}',
            tone: "ok",
          },
        ],
      },
    },
    {
      title: "The actor sleeps. The sandbox pauses.",
      body: "onSleep calls provider.suspend, and E2B pauses the sandbox with its files and ~/.codex intact. The actor's state is saved, so it survives sleep, crashes, and upgrades.",
      focus: ["session", "sandbox"],
      status: { session: "asleep", sandbox: "paused" },
      flows: [{ edge: "session-sandbox", label: "provider.suspend()" }],
      panel: {
        kind: "state",
        title: "while asleep",
        rows: [
          ["actor state", "saved: sandboxId, thread id, transcript"],
          ["sandbox", "paused, files kept"],
          ["~/.codex", "kept in the sandbox"],
          ["on destroy", "provider.destroy deletes the sandbox"],
        ],
      },
    },
    {
      title: "Come back later.",
      body: "The same session id wakes the same actor, and the next prompt resumes the paused sandbox. If the provider deleted it, a new sandbox starts and the thread id is cleared, since its files are gone.",
      focus: ["app", "session"],
      status: { session: "awake", sandbox: "resumed" },
      flows: [
        { edge: "app-session", label: "getTranscript()" },
        { edge: "session-sandbox", label: "provider.connect(c, id)" },
      ],
      panel: {
        kind: "chat",
        title: "session-123",
        messages: [
          { role: "user", text: first },
          { role: "assistant", text: "fib.py prints 0 1 1 2 3 5 8 13 21 34." },
          { role: "user", text: followUp },
          { role: "assistant", text: "fib.py now prints 20 numbers." },
          {
            role: "system",
            text: "Sandbox resumed. Thread 0199a2… continues.",
          },
        ],
      },
    },
  ],
  code: [
    {
      name: "cli.ts",
      note: "Everything specific to Codex: install, exec flags, resume, and how to read its events.",
      source: `// The Codex installer puts the CLI in ~/.local/bin.
const CLI = "$HOME/.local/bin/codex";

// Installs the Codex CLI unless this sandbox already has it.
export const INSTALL = \`test -x \${CLI} || (curl -fsSL https://chatgpt.com/codex/install.sh | sh)\`;

// One run of Codex with no terminal. It prints one JSON event per line.
// Passing the thread id from an earlier run continues that conversation.
export function command(prompt: string, cliSessionId: string | null): string {
  const resume = cliSessionId ? \` resume \${quote(cliSessionId)}\` : "";
  return \`\${CLI} exec --json --skip-git-repo-check --sandbox danger-full-access\${resume} \${quote(prompt)}\`;
}

// The API key reaches Codex as an environment variable of this one process.
export function cliEnv(): Record<string, string> {
  return { CODEX_API_KEY: required("CODEX_API_KEY") };
}

// The fields of Codex's JSON events that this example reads.
export interface CliEvent {
  type: string;
  thread_id?: string;
  item?: { type: string; text?: string };
}

// The first event, \`thread.started\`, names the thread. Each finished agent message is text, and the last one is the answer.
export function readEvent(event: CliEvent): { cliSessionId?: string; answer?: string } {
  return {
    cliSessionId: event.type === "thread.started" ? event.thread_id : undefined,
    answer: event.type === "item.completed" && event.item?.type === "agent_message" ? event.item.text : undefined,
  };
}

// … quote() and required()`,
    },
    {
      name: "session.ts",
      note: "openSandbox creates the sandbox on the first prompt; onSleep pauses it.",
      source: `// E2B pauses the sandbox while the Actor sleeps. The timeout keeps it running through a long task.
const provider = e2bProvider({ create: { timeoutMs: 60 * 60_000 } });

export const codexSession = actor({
  state: { sandboxId: null, cliSessionId: null, transcript: [] } as SessionState,
  events: { output: event<CliEvent>() },
  // … prompt runs command(text, c.state.cliSessionId) with exec
  onSleep: async (c) => {
    if (c.state.sandboxId) await provider.suspend?.(c, c.state.sandboxId);
  },
  onDestroy: async (c) => {
    if (c.state.sandboxId) await provider.destroy?.(c, c.state.sandboxId);
  },
});

// Connects to this session's sandbox. The first prompt creates it.
async function openSandbox(c: SandboxActorContext, state: SessionState): Promise<Sandbox> {
  let sandbox = state.sandboxId ? await provider.connect(c, state.sandboxId) : undefined;
  if (!sandbox) {
    // A new sandbox has none of the earlier files, so the conversation starts over too.
    state.sandboxId = await provider.create(c);
    state.cliSessionId = null;
    sandbox = await provider.connect(c, state.sandboxId);
    if (!sandbox) throw new Error(\`Sandbox \${state.sandboxId} was not found right after it was created.\`);
  }
  const install = await sandbox.exec(INSTALL, { cwd: sandbox.cwd });
  if (install.exitCode !== 0) {
    throw new Error(\`Installing Codex failed. \${install.stdout}\${install.stderr}\`);
  }
  return sandbox;
}`,
    },
  ],
};
