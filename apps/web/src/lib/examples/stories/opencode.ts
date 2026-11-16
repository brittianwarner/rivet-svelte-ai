import type { ExampleStory } from "../types";

const first =
  "Write fib.py that prints the first 10 Fibonacci numbers, then run it.";
const followUp = "Make it print 20 numbers and run it again.";
const base =
  "opencode run --format json --auto --model anthropic/claude-opus-5-5";

export const opencode: ExampleStory = {
  slug: "opencode",
  section: "coding-agents",
  title: "OpenCode",
  tagline:
    "Run OpenCode for each user in a cloud sandbox, with any model provider, and keep the session across visits.",
  ideas: [
    "--model picks any provider/model; cliEnv passes that provider's key.",
    "Every event carries sessionID. The answer is the last text event.",
    "--session continues the conversation stored in the sandbox.",
  ],
  docs: "https://rivet.dev/guides/run-opencode/",
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
        "Or another provider's key. Passed to one exec only, but commands OpenCode runs can read it. Use a key with a spending limit.",
    },
    {
      label: "Authentication",
      detail:
        "Any client that knows a session id can prompt it. Protect the actor in production.",
    },
    {
      label: "Provider",
      detail:
        "E2B streams output. Daytona sends it all at exit. Freestyle's firewall must allow the installer and your model API.",
    },
  ],
  nodes: [
    { id: "app", label: "Your app", kind: "client", x: 14, y: 30 },
    {
      id: "session",
      label: "opencodeSession",
      kind: "actor",
      key: '["session-123"]',
      x: 44,
      y: 30,
    },
    {
      id: "state",
      label: "state",
      kind: "store",
      key: "sandboxId · sessionID",
      x: 44,
      y: 50,
    },
    {
      id: "sandbox",
      label: "E2B sandbox",
      kind: "sandbox",
      key: "~/.opencode/bin/opencode",
      x: 76,
      y: 18,
    },
    {
      id: "api",
      label: "Model provider",
      kind: "service",
      key: "anthropic/claude-opus-5-5",
      x: 76,
      y: 46,
    },
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
      body: "Your app connects to opencodeSession with your session id, listens for output, and sends a prompt. The actor keeps the transcript, the sandbox id, and OpenCode's session id.",
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
            text: 'client.opencodeSession.getOrCreate(["session-123"]).connect()',
            tone: "muted",
          },
          {
            text: 'session.on("output", (event) => console.log(JSON.stringify(event)))',
            tone: "muted",
          },
          { text: `session.prompt("${first}")`, tone: "event" },
        ],
      },
    },
    {
      title: "Create the sandbox, install OpenCode.",
      body: "No sandbox id is stored, so the actor creates one and saves the id. OpenCode's install script puts the CLI in ~/.opencode/bin, and later connects skip the download.",
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
            text: "test -x $HOME/.opencode/bin/opencode || (curl -fsSL https://opencode.ai/install | bash)",
            tone: "command",
          },
          {
            text: "skipped when ~/.opencode/bin/opencode already exists",
            tone: "muted",
          },
          { text: "exit 0", tone: "ok" },
        ],
      },
    },
    {
      title: "Pick any model.",
      body: "--model names the model as provider/model, and cliEnv passes that provider's key to this one process. --auto approves permission requests, because nobody is there to answer them.",
      enter: ["api"],
      focus: ["sandbox", "api"],
      status: { session: "opening", sandbox: "ready" },
      panel: {
        kind: "state",
        title: "opencode run flags",
        rows: [
          ["--format json", "one JSON event per line"],
          ["--auto", "approve what the config does not deny"],
          ["--model", "anthropic/claude-opus-5-5, or any provider"],
          ["--session", "added on follow-ups"],
          ["list models", "opencode models"],
        ],
      },
    },
    {
      title: "Events stream as output.",
      body: "onData receives output as the sandbox reports it. Each JSON line is broadcast to connected clients right away, so your app shows tool calls and text while OpenCode works.",
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
            text: '{"type":"tool_use","sessionID":"ses_7a1c…","part":{…}}',
            tone: "event",
          },
          {
            text: '{"type":"tool_use","sessionID":"ses_7a1c…","part":{…}}',
            tone: "event",
          },
          {
            text: '{"type":"text","sessionID":"ses_7a1c…","part":{"text":"fib.py prints 0 1 1 2 3 5 8 13 21 34."}}',
            tone: "ok",
          },
        ],
      },
    },
    {
      title: "There is no result event.",
      body: "Every event carries sessionID, so the actor saves it from any line. OpenCode prints no final result, so the answer is the text of the last text event.",
      focus: ["session", "state"],
      status: { session: "saved", sandbox: "idle" },
      flows: [
        { edge: "session-state", label: "save sessionID" },
        { edge: "app-session", label: "answer", back: true },
      ],
      panel: {
        kind: "state",
        title: "opencodeSession state",
        rows: [
          ["sandboxId", "saved on create"],
          ["cliSessionId", "ses_7a1c… (any event)"],
          ["answer", "last text event's part.text"],
          ["transcript", "1 user + 1 assistant, after a clean exit"],
        ],
      },
    },
    {
      title: "--session continues it.",
      body: 'The follow-up passes the saved id to --session. OpenCode keeps its sessions in its data directory inside the sandbox, so "it" still means fib.py.',
      focus: ["session", "sandbox"],
      status: { session: "streaming", sandbox: "same session" },
      flows: [
        { edge: "app-session", label: "prompt(text)" },
        { edge: "session-sandbox", label: "exec(--session)" },
        { edge: "sandbox-api", label: "model calls" },
      ],
      panel: {
        kind: "terminal",
        title: "output events",
        lines: [
          {
            text: `${base} --session 'ses_7a1c…' '${followUp}'`,
            tone: "command",
          },
          {
            text: '{"type":"tool_use","sessionID":"ses_7a1c…","part":{…}}',
            tone: "event",
          },
          {
            text: '{"type":"text","sessionID":"ses_7a1c…","part":{"text":"fib.py now prints 20 numbers."}}',
            tone: "ok",
          },
        ],
      },
    },
    {
      title: "The actor sleeps. The sandbox pauses.",
      body: "onSleep calls provider.suspend, and E2B pauses the sandbox with its files and OpenCode's sessions intact. onDestroy would delete it.",
      focus: ["session", "sandbox"],
      status: { session: "asleep", sandbox: "paused" },
      flows: [{ edge: "session-sandbox", label: "provider.suspend()" }],
      panel: {
        kind: "state",
        title: "while asleep",
        rows: [
          ["actor state", "saved: sandboxId, sessionID, transcript"],
          ["sandbox", "paused, files kept"],
          ["OpenCode sessions", "kept in the sandbox"],
          ["on destroy", "provider.destroy deletes the sandbox"],
        ],
      },
    },
    {
      title: "Come back later.",
      body: "Run the client again with the same session id. The actor wakes, the next prompt resumes the paused sandbox, and getTranscript shows the earlier turns.",
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
            text: "Sandbox resumed. Session ses_7a1c… continues.",
          },
        ],
      },
    },
  ],
  code: [
    {
      name: "cli.ts",
      note: "Everything specific to OpenCode: install, model, --session, and how to read its events.",
      source: `// The OpenCode installer puts the CLI in ~/.opencode/bin.
const CLI = "$HOME/.opencode/bin/opencode";

// Any model OpenCode supports, as provider/model. Set that provider's key in cliEnv.
const MODEL = "anthropic/claude-opus-5-5";

// Installs OpenCode unless this sandbox already has it.
export const INSTALL = \`test -x \${CLI} || (curl -fsSL https://opencode.ai/install | bash)\`;

// One run of OpenCode with no terminal. It prints one JSON event per line.
// Passing the session id from an earlier run continues that conversation.
export function command(prompt: string, cliSessionId: string | null): string {
  const resume = cliSessionId ? \` --session \${quote(cliSessionId)}\` : "";
  return \`\${CLI} run --format json --auto --model \${MODEL}\${resume} \${quote(prompt)}\`;
}

// The API key reaches OpenCode as an environment variable of this one process.
export function cliEnv(): Record<string, string> {
  return { ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY") };
}

// The fields of OpenCode's JSON events that this example reads.
export interface CliEvent {
  type: string;
  sessionID?: string;
  part?: { text?: string };
}

// Every event carries the session id. Each \`text\` event is a finished block of text, and the last one is the answer.
export function readEvent(event: CliEvent): { cliSessionId?: string; answer?: string } {
  return {
    cliSessionId: event.sessionID,
    answer: event.type === "text" ? event.part?.text : undefined,
  };
}

// … quote() and required()`,
    },
    {
      name: "client.ts",
      note: "Connect once, print events as they arrive, and send a follow-up that keeps context.",
      source: `import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();

// One Actor per session. Use the same id later to come back to this session.
const session = client.opencodeSession.getOrCreate(["session-123"]).connect();

// OpenCode's events arrive while it works.
session.on("output", (event) => console.log(JSON.stringify(event)));

const answer = await session.prompt("Write fib.py that prints the first 10 Fibonacci numbers, then run it.");
console.log(\`\\nAnswer: \${answer}\`);

// The follow-up runs in the same sandbox and continues the same OpenCode session.
const followUp = await session.prompt("Make it print 20 numbers and run it again.");
console.log(\`\\nAnswer: \${followUp}\`);

await session.dispose();`,
    },
  ],
};
