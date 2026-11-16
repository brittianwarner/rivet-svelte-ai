import type { ExampleStory } from "../types";

const ask =
  "In a single Python script, pull every reading for every sensor with getReadings, use numpy to find spikes more than 5 standard deviations from a rolling mean, find which two sensors are most correlated, and save a note for each spike.";

export const sandboxCodeMode: ExampleStory = {
  slug: "code-mode-in-the-sandbox",
  section: "agents",
  title: "Code Mode in the Sandbox",
  tagline:
    "Let the model write one program that calls your tools dozens of times, without a model round-trip per call.",
  ideas: [
    "The program runs in the sandbox, next to the files and packages it needs.",
    "Each tool call is an action on the agent, so your keys stay on your worker.",
    "The sandbox holds only a scoped token for one agent. Treat it as able to call every action.",
  ],
  docs: "https://rivet.dev/guides/sandbox-code-mode/",
  requires: [
    {
      label: "@rivet-dev/pi + @rivet-dev/sandbox-adapter",
      detail:
        "The agent and its sandbox provider. Also @earendil-works/pi-durable and rivetkit.",
    },
    {
      label: "ANTHROPIC_API_KEY",
      detail: "Or any model provider Pi supports.",
    },
    {
      label: "RIVET_ENDPOINT, public",
      detail:
        "The sandbox calls your gateway. Set RIVET_PUBLIC_ENDPOINT if the sandbox reaches it at another address.",
    },
    {
      label: "Docker, or Daytona or E2B",
      detail:
        "Docker for local development. A hosted sandbox provider in production.",
    },
  ],
  nodes: [
    { id: "cli", label: "You", kind: "client", key: "cli.ts", x: 14, y: 14 },
    { id: "agent", label: "agent", kind: "agent", key: "demo", x: 48, y: 14 },
    {
      id: "model",
      label: "model",
      kind: "service",
      key: "claude-opus-5-5",
      x: 84,
      y: 14,
    },
    {
      id: "sandbox",
      label: "sandbox",
      kind: "sandbox",
      key: "python3, numpy",
      x: 18,
      y: 46,
    },
    {
      id: "script",
      label: "call-tool.sh",
      kind: "sandbox",
      key: "/tmp",
      x: 52,
      y: 46,
    },
    {
      id: "apis",
      label: "your APIs",
      kind: "service",
      key: "your keys",
      x: 84,
      y: 38,
    },
  ],
  edges: [
    { id: "cli-agent", from: "cli", to: "agent" },
    { id: "agent-model", from: "agent", to: "model" },
    { id: "agent-sandbox", from: "agent", to: "sandbox" },
    { id: "sandbox-script", from: "sandbox", to: "script" },
    { id: "script-agent", from: "script", to: "agent" },
    { id: "agent-apis", from: "agent", to: "apis" },
  ],
  beats: [
    {
      title: "Write the script on connect.",
      body: "When the agent connects to its sandbox, it issues a token scoped to itself and writes call-tool.sh outside the workspace. The script is rewritten after every wake.",
      enter: ["agent", "sandbox", "script"],
      focus: ["agent", "script"],
      status: { agent: "connected", script: "chmod 700" },
      flows: [{ edge: "agent-sandbox", label: "writeFile(call-tool.sh)" }],
      panel: {
        kind: "state",
        title: "call-tool.sh",
        rows: [
          ["path", "/tmp/call-tool.sh"],
          ["calls", "POST /gateway/<actorId>/action/<tool>"],
          ["header", "x-rivet-token: <scoped token>"],
          ["token reaches", "this agent only, others 403"],
          ["token lasts", "up to 24 hours"],
        ],
      },
    },
    {
      title: "Ask for a big job.",
      body: "A section in the prompt tells the model how to run the script and lists four tools. The user asks for spikes and correlations across a week of readings from five sensors.",
      enter: ["cli", "model"],
      focus: ["cli", "agent"],
      status: { agent: "thinking" },
      flows: [
        { edge: "cli-agent", label: "prompt()" },
        { edge: "agent-model", label: "request" },
      ],
      panel: {
        kind: "chat",
        title: "agent · demo",
        messages: [
          {
            role: "system",
            text: "Tools via call-tool.sh: progress, saveNote, listNotes, getReadings.",
          },
          { role: "user", text: ask },
        ],
      },
    },
    {
      title: "The model writes a program.",
      body: "Instead of calling getReadings itself, the model writes a Python script and runs it with bash. One model reply starts all the work.",
      focus: ["model", "sandbox"],
      status: { model: "one reply", sandbox: "running" },
      flows: [{ edge: "agent-sandbox", label: "bash" }],
      panel: {
        kind: "terminal",
        title: "cli.ts",
        lines: [
          { text: `you> ${ask.slice(0, 64)}…`, tone: "muted" },
          {
            text: '> write {"path":"/workspace/spikes.py","content":"..."}',
            tone: "event",
          },
          { text: "> $ python3 /workspace/spikes.py", tone: "command" },
        ],
      },
    },
    {
      title: "The program calls the agent.",
      body: "Each tool call is a curl to an action on the agent, signed with the scoped token. The action's return value comes back as JSON on stdout.",
      focus: ["script", "agent"],
      status: { model: "idle", sandbox: "running", script: "calling" },
      flows: [
        { edge: "sandbox-script", label: "getReadings" },
        { edge: "script-agent", label: "/action/getReadings" },
      ],
      panel: {
        kind: "terminal",
        title: "inside spikes.py",
        lines: [
          {
            text: `/tmp/call-tool.sh getReadings '["boiler", 0]'`,
            tone: "command",
          },
          {
            text: '{"output": {"readings": [ …1,000… ], "next": 1000}}',
            tone: "ok",
          },
          {
            text: `/tmp/call-tool.sh getReadings '["boiler", 1000]'`,
            tone: "command",
          },
          {
            text: '{"output": {"readings": [ …1,000… ], "next": 2000}}',
            tone: "ok",
          },
        ],
      },
    },
    {
      title: "Actions hold the keys.",
      body: "The action runs in your backend and queries your metrics database with your credentials. The model key and tool credentials never enter the sandbox.",
      enter: ["apis"],
      focus: ["agent", "apis"],
      status: { model: "idle", script: "calling" },
      flows: [{ edge: "agent-apis", label: "query readings" }],
      panel: {
        kind: "state",
        title: "who holds what",
        rows: [
          ["sandbox", "scoped token for one agent"],
          ["your worker", "Rivet token, model key, API keys"],
          ["gateway URL", "Rivet token stripped out"],
          ["agent history", "in the actor, not the sandbox"],
        ],
      },
    },
    {
      title: "Dozens of calls, no round-trips.",
      body: "The script makes all 55 getReadings calls itself. None of the 50,400 readings pass through the model. progress broadcasts status to the user as it goes.",
      focus: ["script", "cli"],
      status: { model: "idle", script: "55 calls" },
      flows: [
        { edge: "script-agent", label: "progress" },
        { edge: "cli-agent", label: "progress event", back: true },
      ],
      panel: {
        kind: "terminal",
        title: "cli.ts",
        lines: [
          { text: "> $ python3 /workspace/spikes.py", tone: "command" },
          { text: "[progress] Fetching readings for 5 sensors", tone: "event" },
          {
            text: "getReadings × 55, 50,400 readings, 0 model calls",
            tone: "muted",
          },
          { text: "[progress] Saving 4 spike notes", tone: "event" },
          { text: "saveNote × 4", tone: "muted" },
        ],
      },
    },
    {
      title: "The model reads only the result.",
      body: "The script prints a short summary. That is all the model sees before it answers. The notes stay in the agent's state after the sandbox is gone.",
      focus: ["model", "cli"],
      status: { model: "answering", sandbox: "done" },
      flows: [
        { edge: "agent-model", label: "script output" },
        { edge: "cli-agent", label: "answer", back: true },
      ],
      panel: {
        kind: "chat",
        title: "agent · demo",
        messages: [
          { role: "user", text: ask, ghost: true },
          {
            role: "tool",
            text: "python3 /workspace/spikes.py → 4 spikes, top pair boiler/pump",
          },
          {
            role: "assistant",
            text: "Boiler and pump are the most correlated pair (r = 0.95). I found 4 spikes: tank at 1234 and 9001, boiler at 4321, pump at 7777.",
            streaming: true,
          },
        ],
      },
    },
    {
      title: "Check every argument.",
      body: "The model writes the arguments, and the token can call every action on the agent, including prompt. Add only tools you would let sandboxed code call, and reject bad input with a UserError.",
      focus: ["agent", "script"],
      status: { script: "exit non-zero" },
      flows: [{ edge: "script-agent", label: "/action/saveNote" }],
      panel: {
        kind: "terminal",
        title: "sandbox",
        lines: [
          { text: `/tmp/call-tool.sh saveNote '[""]'`, tone: "command" },
          { text: "Pass a non-empty string.", tone: "error" },
          { text: "script exits non-zero; nothing saved", tone: "muted" },
        ],
      },
    },
  ],
  code: [
    {
      name: "callback.ts",
      note: "Issue a scoped token and write call-tool.sh into every sandbox the agent connects to.",
      source: `// Outside the workspace, so the agent doesn't commit it.
export const SCRIPT_PATH = "/tmp/call-tool.sh";

// The maximum. The script is rewritten after every wake.
const TOKEN_TTL_SECONDS = 24 * 60 * 60;

// Writes the script into every sandbox the agent connects to.
export function withCallbackScript(provider: SandboxProvider): SandboxProvider {
  return {
    ...provider,
    connect: async (c, id) => {
      const sandbox = await provider.connect(c, id);
      if (sandbox) await writeScript(sandbox, c);
      return sandbox;
    },
  };
}

async function writeScript(sandbox: Sandbox, c: SandboxActorContext): Promise<void> {
  // The scoped token reaches only this Actor, but can call every action on it.
  const client = c.client() as Client<typeof registry>;
  const { token } = await client.agent
    .getForId(c.actorId)
    .issueToken({ subject: "sandbox", expiresIn: TOKEN_TTL_SECONDS });
  await sandbox.writeFile(SCRIPT_PATH, callbackScript(\`\${gatewayEndpoint()}/gateway/\${c.actorId}\`, token));
  const chmod = await sandbox.exec(\`chmod 700 \${SCRIPT_PATH}\`, { cwd: sandbox.cwd });
  if (chmod.exitCode !== 0) throw new Error(\`Installing \${SCRIPT_PATH} failed. \${chmod.stderr}\`);
}

// Calls one tool (an action on the agent) through the gateway and prints the JSON reply.
function callbackScript(actorUrl: string, token: string): string {
  return \`#!/bin/sh
# Usage: \${SCRIPT_PATH} <tool> '<JSON array of arguments>'
set -eu
[ $# -ge 1 ] || { echo "usage: $0 <tool> '<JSON array of arguments>'" >&2; exit 2; }
exec curl -sS --fail-with-body -X POST \\\\
  -H \${quote(\`x-rivet-token: \${token}\`)} \\\\
  -H 'content-type: application/json' \\\\
  --data "{\\\\"args\\\\":\\\${2:-[]}}" \\\\
  \${quote(\`\${actorUrl}/action/\`)}"$1"
\`;
}
// … gatewayEndpoint() strips your Rivet token; quote() escapes for sh.`,
    },
    {
      name: "server.ts",
      note: "Each tool is an action on the agent. Check what the model passes in.",
      source: `export const agent = pi({
  model: "anthropic/claude-opus-5-5",
  registry: extensions,
  // Writes call-tool.sh into the sandbox. Docker is for local development;
  // in production, use a hosted provider such as Daytona or E2B.
  sandbox: withCallbackScript(dockerProvider({ image: "sandbox-code-mode" })),
  state: { notes: [] as string[] },
  events: {
    progress: event<string>(),
  },
  // The tools call-tool.sh calls. Each one is an action on the agent.
  actions: {
    progress: (c, message: unknown) => {
      c.broadcast("progress", requireText(message));
      return null;
    },
    saveNote: (c, text: unknown) => {
      c.state.notes.push(requireText(text));
      return { saved: c.state.notes.length };
    },
    listNotes: (c) => c.state.notes,
    // In a real app, this queries your metrics database with your keys.
    getReadings: (_c, sensor: unknown, cursor: unknown) => readingsPage(sensor, cursor),
  },
});

// The model writes the arguments, so check them. A UserError makes the script exit non-zero.
function requireText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new UserError("Pass a non-empty string.");
  return value;
}`,
    },
    {
      name: "section.ts",
      note: "A prompt section teaches the model the script and its tools.",
      source: `// Coding tools run in the sandbox. The section tells the model about the script.
const extensions = createRegistry();
extensions.install(CodingTools);
extensions.install(
  defineExtension({
    name: "agent-callbacks",
    sections: [
      section(
        "agent_callbacks",
        () => \`To call the app that runs you, use bash to run:
\${SCRIPT_PATH} <tool> '<JSON array of arguments>'
It prints {"output": <result>}, or exits non-zero with an error.

Tools:
- progress ["<message>"]: Shows the user a one-line status. Call it as you start each step of a task.
- saveNote ["<text>"]: Saves a note that is kept after the sandbox is deleted.
- listNotes []: Returns every saved note.
- getReadings ["<sensor>", <cursor>]: Returns {"readings": [...], "next": <cursor or null>}, 1,000 readings a page, one a minute for a week. Start at cursor 0. Sensors: \${SENSORS.join(", ")}.

Example: \${SCRIPT_PATH} progress '["Running the tests"]'\`,
      ),
    ],
  }),
);`,
    },
  ],
};
