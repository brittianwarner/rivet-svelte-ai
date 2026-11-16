import type { ExampleStory } from "../types";

const first =
  "Write fib.py that prints the first 10 Fibonacci numbers, then run it.";
const followUp = "Make it print 20 numbers and run it again.";

export const amp: ExampleStory = {
  slug: "amp",
  section: "coding-agents",
  title: "Amp",
  tagline:
    "Run the Amp CLI for each user in a cloud sandbox, with the thread kept on Amp's servers and the files kept in the sandbox.",
  ideas: [
    "amp -x runs one turn and exits; --stream-json prints every event as a line.",
    "Amp stores threads on its own servers. The actor keeps only the thread id.",
    "threads continue sends a follow-up to the same thread.",
  ],
  docs: "https://rivet.dev/guides/run-amp/",
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
      label: "AMP_API_KEY",
      detail:
        "An access token from Amp settings. The token amp login saves is rejected. Code in the sandbox can read it and spend from your Amp account.",
    },
    {
      label: "Amp account",
      detail:
        "Use an account or workspace you are willing to expose to the sandbox.",
    },
    {
      label: "Authentication",
      detail:
        "Any client that knows a session id can prompt it. Protect the actor in production.",
    },
  ],
  nodes: [
    { id: "app", label: "Your app", kind: "client", x: 14, y: 30 },
    {
      id: "session",
      label: "ampSession",
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
      key: "~/.amp/bin/amp",
      x: 76,
      y: 18,
    },
    {
      id: "amp",
      label: "Amp service",
      kind: "service",
      key: "model + threads",
      x: 76,
      y: 46,
    },
  ],
  edges: [
    { id: "app-session", from: "app", to: "session" },
    { id: "session-state", from: "session", to: "state", dashed: true },
    { id: "session-sandbox", from: "session", to: "sandbox" },
    { id: "sandbox-amp", from: "sandbox", to: "amp" },
  ],
  beats: [
    {
      title: "One actor per session.",
      body: "Your app connects to ampSession with your session id and sends a prompt. The actor keeps the transcript, the sandbox id, and the id of the Amp thread.",
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
            text: 'client.ampSession.getOrCreate(["session-123"]).connect()',
            tone: "muted",
          },
          { text: `session.prompt("${first}")`, tone: "event" },
        ],
      },
    },
    {
      title: "Create the sandbox, install Amp.",
      body: "No sandbox id is stored, so the actor creates one and saves the id. Amp's install script puts the CLI in ~/.amp/bin, and later connects skip the download.",
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
            text: "test -x $HOME/.amp/bin/amp || (curl -fsSL https://ampcode.com/install.sh | bash)",
            tone: "command",
          },
          { text: "skipped when ~/.amp/bin/amp already exists", tone: "muted" },
          { text: "exit 0", tone: "ok" },
        ],
      },
    },
    {
      title: "Execute mode.",
      body: "-x sends the prompt, waits for the agent to finish its turn, and exits. Amp does not ask before running tools by default, so no approval flag is needed. The sandbox is the boundary.",
      focus: ["sandbox"],
      status: { session: "opening", sandbox: "ready" },
      panel: {
        kind: "state",
        title: "amp command",
        rows: [
          ["-x", "execute mode: one turn, then exit"],
          ["--stream-json", "one JSON event per line, Claude Code's shape"],
          ["threads continue <id>", "added on follow-ups"],
          ["AMP_API_KEY", "in this exec's env only"],
        ],
      },
    },
    {
      title: "Events stream as output.",
      body: "Amp calls its own service, which runs the model. onData receives each JSON line as the sandbox reports it, and the actor broadcasts it to your app right away.",
      enter: ["amp"],
      focus: ["sandbox", "amp", "app"],
      status: { session: "streaming", sandbox: "running" },
      flows: [
        { edge: "session-sandbox", label: "exec(amp -x)" },
        { edge: "sandbox-amp", label: "turn" },
        { edge: "app-session", label: "output", back: true },
      ],
      panel: {
        kind: "terminal",
        title: "output events",
        lines: [
          { text: `amp -x '${first}' --stream-json`, tone: "command" },
          {
            text: '{"type":"system","subtype":"init","session_id":"T-5d0c…"}',
            tone: "event",
          },
          {
            text: '{"type":"assistant","message":{"content":[{"type":"tool_use",…}]}}',
            tone: "event",
          },
          {
            text: '{"type":"result","result":"fib.py prints 0 1 1 2 3 5 8 13 21 34.","session_id":"T-5d0c…"}',
            tone: "ok",
          },
        ],
      },
    },
    {
      title: "The thread lives on Amp.",
      body: "The first event, init, carries the thread id, which Amp names session_id. The thread itself is stored on Amp's servers, not in the sandbox. The actor saves the id and the turn.",
      focus: ["session", "state", "amp"],
      status: { session: "saved", amp: "thread stored" },
      flows: [
        { edge: "session-state", label: "save thread id" },
        { edge: "app-session", label: "answer", back: true },
      ],
      panel: {
        kind: "state",
        title: "where things live",
        rows: [
          ["thread", "Amp's servers"],
          ["thread id", "actor state: T-5d0c…"],
          ["files (fib.py)", "the sandbox"],
          ["transcript", "actor state, after a clean exit"],
        ],
      },
    },
    {
      title: "threads continue.",
      body: 'The follow-up puts threads continue and the saved id before -x. Amp sends the prompt to the existing thread, so "it" still means fib.py.',
      focus: ["session", "sandbox", "amp"],
      status: { session: "streaming", sandbox: "running", amp: "same thread" },
      flows: [
        { edge: "app-session", label: "prompt(text)" },
        { edge: "session-sandbox", label: "exec(threads continue)" },
        { edge: "sandbox-amp", label: "turn" },
      ],
      panel: {
        kind: "terminal",
        title: "output events",
        lines: [
          {
            text: `amp threads continue 'T-5d0c…' -x '${followUp}' --stream-json`,
            tone: "command",
          },
          {
            text: '{"type":"system","subtype":"init","session_id":"T-5d0c…"}',
            tone: "event",
          },
          {
            text: '{"type":"result","result":"fib.py now prints 20 numbers.","session_id":"T-5d0c…"}',
            tone: "ok",
          },
        ],
      },
    },
    {
      title: "The actor sleeps. The sandbox pauses.",
      body: "onSleep calls provider.suspend, and E2B pauses the sandbox with its files intact. The thread stays on Amp's servers either way.",
      focus: ["session", "sandbox"],
      status: { session: "asleep", sandbox: "paused" },
      flows: [{ edge: "session-sandbox", label: "provider.suspend()" }],
      panel: {
        kind: "state",
        title: "while asleep",
        rows: [
          ["actor state", "saved: sandboxId, thread id, transcript"],
          ["sandbox", "paused, files kept"],
          ["thread", "on Amp's servers"],
          ["on destroy", "provider.destroy deletes the sandbox"],
        ],
      },
    },
    {
      title: "Come back later.",
      body: "The same session id wakes the same actor, and the next prompt resumes the paused sandbox. If the sandbox is gone, the actor clears the thread id: the old thread talks about files the new sandbox does not have.",
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
            text: "Sandbox resumed. Thread T-5d0c… continues.",
          },
        ],
      },
    },
  ],
  code: [
    {
      name: "cli.ts",
      note: "Everything specific to Amp: install, execute mode, threads continue, and how to read its events.",
      source: `// The Amp installer puts the CLI in ~/.amp/bin.
const CLI = "$HOME/.amp/bin/amp";

// Installs the Amp CLI unless this sandbox already has it.
export const INSTALL = \`test -x \${CLI} || (curl -fsSL https://ampcode.com/install.sh | bash)\`;

// One run of Amp in execute mode. It prints one JSON event per line.
// Passing the thread id from an earlier run continues that thread.
export function command(prompt: string, cliSessionId: string | null): string {
  const resume = cliSessionId ? \` threads continue \${quote(cliSessionId)}\` : "";
  return \`\${CLI}\${resume} -x \${quote(prompt)} --stream-json\`;
}

// The access token reaches Amp as an environment variable of this one process.
export function cliEnv(): Record<string, string> {
  return { AMP_API_KEY: required("AMP_API_KEY") };
}

// The fields of Amp's JSON events that this example reads.
export interface CliEvent {
  type: string;
  session_id?: string;
  result?: string;
}

// Every event carries the thread id. The last event, \`result\`, holds the final answer.
export function readEvent(event: CliEvent): { cliSessionId?: string; answer?: string } {
  return {
    cliSessionId: event.session_id,
    answer: event.type === "result" ? event.result : undefined,
  };
}

// … quote() and required()`,
    },
    {
      name: "session.ts",
      note: "A new sandbox clears the thread id, because the old thread refers to files that are gone.",
      source: `const provider = e2bProvider({ create: { timeoutMs: 60 * 60_000 } });

export const ampSession = actor({
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
    throw new Error(\`Installing Amp failed. \${install.stdout}\${install.stderr}\`);
  }
  return sandbox;
}`,
    },
  ],
};
