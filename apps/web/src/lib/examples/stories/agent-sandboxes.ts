import type { ExampleStory } from "../types";

const ask = { role: "user", text: "Add a test for fib() and run it." } as const;

export const agentSandboxes: ExampleStory = {
  slug: "give-an-agent-a-sandbox",
  section: "coding-agents",
  title: "Give an Agent a Sandbox",
  tagline:
    "Give a Pi agent a real shell for tests and builds, only when it needs one.",
  ideas: [
    "Without a sandbox, file tools use the actor's SQLite and bash returns an error.",
    "Pass a provider to pi() and CodingTools run in that actor's own sandbox.",
    "The actor stores the sandbox id and reconnects after a wake.",
  ],
  docs: "https://rivet.dev/guides/agent-sandboxes/",
  requires: [
    {
      label: "@rivet-dev/pi",
      detail: "pi() takes the sandbox option. The guide pins no version.",
    },
    {
      label: "@earendil-works/pi-durable",
      detail: "createRegistry and CodingTools: read, write, edit, and bash.",
    },
    {
      label: "@rivet-dev/sandbox-adapter",
      detail:
        "agentOSProvider, e2bProvider, daytonaProvider, freestyleProvider, dockerProvider.",
    },
    {
      label: "rivetkit",
      detail: "setup and the registry. This repo pins 3.0.1.",
    },
    {
      label: "ANTHROPIC_API_KEY",
      detail: "For the model. Or any model provider Pi supports.",
    },
    {
      label: "agentOS",
      detail:
        "Needs no provider account. E2B, Daytona, and Freestyle need their SDK and API key.",
    },
  ],
  nodes: [
    { id: "you", label: "You", kind: "client", x: 14, y: 30 },
    {
      id: "agent",
      label: "agent",
      kind: "agent",
      key: '["fix-tests"]',
      x: 44,
      y: 30,
    },
    {
      id: "files",
      label: "files",
      kind: "store",
      key: "actor SQLite",
      x: 44,
      y: 50,
    },
    {
      id: "vm",
      label: "agentOS VM",
      kind: "sandbox",
      key: '["sandbox", <agent id>]',
      x: 76,
      y: 18,
    },
    {
      id: "e2b",
      label: "E2B sandbox",
      kind: "sandbox",
      key: "template: base",
      x: 76,
      y: 44,
    },
  ],
  edges: [
    { id: "you-agent", from: "you", to: "agent" },
    { id: "agent-files", from: "agent", to: "files", dashed: true },
    { id: "agent-vm", from: "agent", to: "vm" },
    { id: "agent-e2b", from: "agent", to: "e2b" },
  ],
  beats: [
    {
      title: "No sandbox by default.",
      body: "Leave out the sandbox option and Pi's file tools work on files in the actor's own SQLite database. There is nothing to provision, and no shell.",
      enter: ["you", "agent", "files"],
      focus: ["agent", "files"],
      status: { agent: "no sandbox" },
      flows: [{ edge: "agent-files", label: "write" }],
      panel: {
        kind: "chat",
        title: "agent · fix-tests",
        messages: [
          ask,
          {
            role: "tool",
            text: "write test/fib.test.ts → saved in the actor's database",
          },
          {
            role: "tool",
            text: "bash npm test → error: no shell without a sandbox",
          },
          {
            role: "assistant",
            text: "The test is written. Running it needs a sandbox.",
          },
        ],
      },
    },
    {
      title: "Pass a provider.",
      body: "Install CodingTools and pass sandbox: agentOSProvider() to pi(). read, write, edit, and bash now run in a sandbox, and agentOS needs no account.",
      focus: ["agent"],
      status: { agent: "agentos sandbox" },
      panel: {
        kind: "state",
        title: "with and without",
        rows: [
          ["no sandbox · files", "the actor's SQLite database"],
          ["no sandbox · shell", "none; bash returns an error"],
          ["sandbox · files", "in the sandbox"],
          ["sandbox · shell", "bash runs in the sandbox"],
          ["sandbox · setup", "agentOS, or a provider account"],
        ],
      },
    },
    {
      title: "Created on first use.",
      body: "The sandbox appears the first time the agent needs it. With agentOS it is an agentOS actor in the services pool, keyed by the agent actor's id.",
      enter: ["vm"],
      focus: ["agent", "vm"],
      status: { agent: "running tools", vm: "created" },
      flows: [{ edge: "agent-vm", label: "create(c)" }],
      panel: {
        kind: "state",
        title: "the agent's sandbox",
        rows: [
          ["provider", "agentOS"],
          ["key", '["sandbox", <agent actor id>]'],
          ["pool", "services"],
          ["cwd", "/workspace"],
          ["account", "none"],
        ],
      },
    },
    {
      title: "Tools run in the sandbox.",
      body: "bash runs the tests in the VM. File tools reject paths outside the working directory, but shell commands can reach anything inside the sandbox.",
      focus: ["agent", "vm"],
      status: { agent: "running tools", vm: "npm test" },
      flows: [{ edge: "agent-vm", label: "exec(npm test)" }],
      panel: {
        kind: "chat",
        title: "agent · fix-tests",
        messages: [
          ask,
          { role: "tool", text: "write /workspace/test/fib.test.ts" },
          { role: "tool", text: "bash npm test → 3 passed" },
          { role: "assistant", text: "Added three cases for fib(). All pass." },
        ],
      },
    },
    {
      title: "Sleep keeps the files.",
      body: "The agent sleeps when idle. The agentOS VM keeps its files in its own SQLite database and sleeps on its own, so they are there when the agent wakes.",
      focus: ["agent", "vm"],
      status: { agent: "asleep", vm: "asleep, files kept" },
      panel: {
        kind: "state",
        title: "while the agent sleeps",
        rows: [
          ["agent state", "saved, including the sandbox id"],
          ["agentOS VM", "sleeps when idle, keeps its files"],
          ["Sandbox object", "gone; it lives only in memory"],
        ],
      },
    },
    {
      title: "Reconnect on the next tool call.",
      body: "After a wake, the agent connects to the same sandbox the first time a tool needs it. If it no longer exists, a new one starts and the old files are lost.",
      focus: ["agent", "vm", "you"],
      status: { agent: "awake", vm: "connected" },
      flows: [
        { edge: "you-agent", label: "prompt(text)" },
        { edge: "agent-vm", label: "connect(c, id)" },
      ],
      panel: {
        kind: "chat",
        title: "agent · fix-tests",
        messages: [
          { ...ask, ghost: true },
          {
            role: "assistant",
            text: "Added three cases for fib(). All pass.",
            ghost: true,
          },
          { role: "user", text: "Add a case for fib(0)." },
          { role: "tool", text: "edit /workspace/test/fib.test.ts" },
          { role: "tool", text: "bash npm test → 4 passed" },
        ],
      },
    },
    {
      title: "Or use a provider account.",
      body: "For E2B, Daytona, Freestyle, or local Docker, change one import and one call. Provider credentials stay on your worker. An existing actor cannot switch providers.",
      enter: ["e2b"],
      focus: ["e2b"],
      status: { agent: "new definition", e2b: "e2b provider" },
      flows: [{ edge: "agent-e2b", label: "create(c)" }],
      panel: {
        kind: "state",
        title: "provider · while asleep · on destroy",
        rows: [
          ["agentOS", "sleeps, keeps files · left in place"],
          ["E2B", "paused · deleted"],
          ["Daytona", "stopped · deleted"],
          ["Freestyle", "paused · deleted"],
          ["Docker", "stopped · removed"],
        ],
      },
    },
  ],
  code: [
    {
      name: "server.ts",
      note: "One option turns the agent's tools into sandbox tools.",
      source: `import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { agentOSProvider } from "@rivet-dev/sandbox-adapter/agentos";
import { setup } from "rivetkit";

// read, write, edit, and bash, running in the sandbox
const extensions = createRegistry();
extensions.install(CodingTools);

const agent = pi({
  model: "anthropic/claude-opus-5-5",
  registry: extensions,
  sandbox: agentOSProvider(),
});

export const registry = setup({ use: { agent } });

registry.start();`,
    },
    {
      name: "server.e2b.ts",
      note: "Swap the provider. E2B pauses on sleep and is deleted with the actor.",
      source: `import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
// … same imports and registry as server.ts

const agent = pi({
  model: "anthropic/claude-opus-5-5",
  registry: extensions,
  sandbox: e2bProvider({ template: "base" }),
});`,
    },
  ],
};
