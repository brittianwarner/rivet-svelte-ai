import type { ExampleStory } from "../types";

const first =
  "Write fib.py that prints the first 10 Fibonacci numbers, then run it.";
const followUp = "Make it print 20 numbers and run it again.";
const flags =
  "--output-format stream-json --verbose --dangerously-skip-permissions";

export const claudeCode: ExampleStory = {
  slug: "claude-code",
  section: "coding-agents",
  title: "Claude Code",
  tagline:
    "Run Claude Code for each user in a cloud sandbox that remembers the conversation between visits.",
  ideas: [
    "One actor per session stores the sandbox id and Claude Code's own session id.",
    "--resume continues the conversation because ~/.claude lives in the sandbox.",
    "When the actor sleeps the sandbox pauses, and the next prompt resumes it.",
  ],
  docs: "https://rivet.dev/guides/run-claude-code/",
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
      label: "ANTHROPIC_API_KEY",
      detail:
        "Passed to one exec only, but commands Claude Code runs can read it. Use a key with a spending limit.",
    },
    {
      label: "Authentication",
      detail:
        "Any client that knows a session id can prompt it. Protect the actor in production.",
    },
    {
      label: "Provider",
      detail:
        "E2B streams output. Daytona works but sends it all at exit. Freestyle runs as root, which Claude Code refuses here.",
    },
  ],
  nodes: [
    { id: "app", label: "Your app", kind: "client", x: 14, y: 30 },
    {
      id: "session",
      label: "claudeSession",
      kind: "actor",
      key: '["session-123"]',
      x: 44,
      y: 30,
    },
    {
      id: "state",
      label: "state",
      kind: "store",
      key: "sandboxId · cliSessionId",
      x: 44,
      y: 50,
    },
    {
      id: "sandbox",
      label: "E2B sandbox",
      kind: "sandbox",
      key: "~/.local/bin/claude",
      x: 76,
      y: 18,
    },
    { id: "api", label: "Anthropic API", kind: "service", x: 76, y: 46 },
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
      body: "Your app connects to claudeSession with your session id and sends a prompt. The actor keeps the transcript, the sandbox id, and Claude Code's own session id.",
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
            text: 'client.claudeSession.getOrCreate(["session-123"]).connect()',
            tone: "muted",
          },
          { text: `session.prompt("${first}")`, tone: "event" },
        ],
      },
    },
    {
      title: "The first prompt creates a sandbox.",
      body: "No sandbox id is stored yet, so the actor calls provider.create and saves the id right away. The E2B key stays on the worker.",
      enter: ["sandbox"],
      focus: ["session", "sandbox"],
      status: { session: "opening", sandbox: "creating" },
      flows: [
        { edge: "session-sandbox", label: "provider.create(c)" },
        { edge: "session-state", label: "save sandboxId" },
      ],
      panel: {
        kind: "state",
        title: "claudeSession state",
        rows: [
          ["sandboxId", "new id from E2B"],
          ["cliSessionId", "null"],
          ["transcript", "0 turns"],
          ["vars.running", "true (not saved)"],
        ],
      },
    },
    {
      title: "Install Claude Code once.",
      body: "The install line runs on every connect but returns at once when the CLI is there. Claude Code installs into the sandbox, never onto your worker.",
      focus: ["sandbox"],
      status: { session: "opening", sandbox: "installing" },
      flows: [{ edge: "session-sandbox", label: "exec(INSTALL)" }],
      panel: {
        kind: "terminal",
        title: "sandbox",
        lines: [
          {
            text: "test -x $HOME/.local/bin/claude || (curl -fsSL https://claude.ai/install.sh | bash)",
            tone: "command",
          },
          {
            text: "skipped when ~/.local/bin/claude already exists",
            tone: "muted",
          },
          { text: "exit 0", tone: "ok" },
        ],
      },
    },
    {
      title: "Run claude -p and stream.",
      body: "-p runs one prompt with no terminal. stream-json prints one JSON event per line, and Claude Code needs --verbose with it. Each line reaches your app as an output event.",
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
          { text: `claude -p '${first}' ${flags}`, tone: "command" },
          {
            text: '{"type":"system","subtype":"init","session_id":"4b1e…"}',
            tone: "event",
          },
          {
            text: '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write",…}]}}',
            tone: "event",
          },
          {
            text: '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash",…}]}}',
            tone: "event",
          },
          {
            text: '{"type":"result","result":"fib.py prints 0 1 1 2 3 5 8 13 21 34.","session_id":"4b1e…"}',
            tone: "ok",
          },
        ],
      },
    },
    {
      title: "The answer lands in state.",
      body: "Every event carries Claude Code's session id, and the result event holds the answer. The turn is saved only after a clean exit. A failed run throws a UserError with the reason.",
      focus: ["session", "state"],
      status: { session: "saved", sandbox: "idle" },
      flows: [
        { edge: "session-state", label: "save turn" },
        { edge: "app-session", label: "answer", back: true },
      ],
      panel: {
        kind: "state",
        title: "claudeSession state",
        rows: [
          ["sandboxId", "same id"],
          ["cliSessionId", "4b1e… (from the events)"],
          ["transcript", "1 user + 1 assistant"],
          ["key exposure", "ANTHROPIC_API_KEY in this exec's env only"],
        ],
      },
    },
    {
      title: "The follow-up resumes.",
      body: 'The saved id goes to --resume. Claude Code keeps its sessions under ~/.claude in the sandbox, so "it" still means fib.py.',
      focus: ["session", "sandbox"],
      status: { session: "streaming", sandbox: "resumed session" },
      flows: [
        { edge: "app-session", label: "prompt(text)" },
        { edge: "session-sandbox", label: "exec(--resume)" },
        { edge: "sandbox-api", label: "model calls" },
      ],
      panel: {
        kind: "terminal",
        title: "output events",
        lines: [
          {
            text: `claude -p '${followUp}' ${flags} --resume '4b1e…'`,
            tone: "command",
          },
          {
            text: '{"type":"system","subtype":"init","session_id":"4b1e…"}',
            tone: "event",
          },
          {
            text: '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit",…}]}}',
            tone: "event",
          },
          {
            text: '{"type":"result","result":"fib.py now prints 20 numbers.","session_id":"4b1e…"}',
            tone: "ok",
          },
        ],
      },
    },
    {
      title: "The actor sleeps. The sandbox pauses.",
      body: "When the session goes quiet, onSleep calls provider.suspend. E2B pauses the sandbox with its files and Claude Code's sessions intact.",
      focus: ["session", "sandbox"],
      status: { session: "asleep", sandbox: "paused" },
      flows: [{ edge: "session-sandbox", label: "provider.suspend()" }],
      panel: {
        kind: "state",
        title: "while asleep",
        rows: [
          ["actor state", "saved: sandboxId, cliSessionId, transcript"],
          ["sandbox", "paused, files kept"],
          ["~/.claude", "kept in the sandbox"],
          ["on destroy", "provider.destroy deletes the sandbox"],
        ],
      },
    },
    {
      title: "Come back later.",
      body: "The same session id wakes the same actor. The next prompt reconnects to the paused sandbox, and getTranscript shows the earlier turns.",
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
            text: "Sandbox resumed. Files and session intact.",
          },
        ],
      },
    },
  ],
  code: [
    {
      name: "cli.ts",
      note: "Everything specific to Claude Code: install, headless flags, and how to read its events.",
      source: `// Claude Code's installer puts the CLI in ~/.local/bin.
const CLI = "$HOME/.local/bin/claude";

// Installs Claude Code unless this sandbox already has it.
export const INSTALL = \`test -x \${CLI} || (curl -fsSL https://claude.ai/install.sh | bash)\`;

// One run of Claude Code with no terminal. It prints one JSON event per line.
// Passing the session id from an earlier run continues that conversation.
export function command(prompt: string, cliSessionId: string | null): string {
  const resume = cliSessionId ? \` --resume \${quote(cliSessionId)}\` : "";
  return \`\${CLI} -p \${quote(prompt)} --output-format stream-json --verbose --dangerously-skip-permissions\${resume}\`;
}

// The API key reaches Claude Code as an environment variable of this one process.
export function cliEnv(): Record<string, string> {
  return { ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY") };
}

// The fields of Claude Code's JSON events that this example reads.
export interface CliEvent {
  type: string;
  session_id?: string;
  result?: string;
}

// Every event carries the session id. The last event, \`result\`, holds the final answer.
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
      note: "The prompt action streams each event and saves the CLI session id for --resume.",
      source: `const provider = e2bProvider({ create: { timeoutMs: 60 * 60_000 } });

export const claudeSession = actor({
  state: { sandboxId: null, cliSessionId: null, transcript: [] } as SessionState,
  events: { output: event<CliEvent>() },
  createVars: () => ({ running: false }),
  options: { actionTimeout: PROMPT_TIMEOUT_MS + 60_000 },
  actions: {
    prompt: async (c, text: string) => {
      if (c.vars.running) throw new UserError("A prompt is already running in this session.");
      c.vars.running = true;
      try {
        const sandbox = await openSandbox(c, c.state);
        let answer = "";
        const result = await sandbox.exec(command(text, c.state.cliSessionId), {
          cwd: sandbox.cwd,
          env: cliEnv(),
          timeoutMs: PROMPT_TIMEOUT_MS,
          signal: c.abortSignal,
          onData: jsonLines((event) => {
            const read = readEvent(event);
            if (read.cliSessionId) c.state.cliSessionId = read.cliSessionId;
            if (read.answer !== undefined) answer = read.answer;
            c.broadcast("output", event);
          }),
        });
        // … timedOut and exitCode checks throw a UserError
        c.state.transcript.push({ role: "user", text }, { role: "assistant", text: answer });
        return answer;
      } finally {
        c.vars.running = false;
      }
    },
    getTranscript: (c) => c.state.transcript,
  },
  onSleep: async (c) => {
    if (c.state.sandboxId) await provider.suspend?.(c, c.state.sandboxId);
  },
  onDestroy: async (c) => {
    if (c.state.sandboxId) await provider.destroy?.(c, c.state.sandboxId);
  },
});`,
    },
  ],
};
