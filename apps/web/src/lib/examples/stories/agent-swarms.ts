import type { ChatLine, ExampleStory } from "../types";

const rules: ChatLine[] = [
  {
    role: "user",
    text: "You review TypeScript for our team. We care about error handling and clear names.",
  },
  {
    role: "assistant",
    text: "Understood. I will flag swallowed errors and vague names first.",
  },
];

const ghostRules: ChatLine[] = rules.map((line) => ({ ...line, ghost: true }));

export const agentSwarms: ExampleStory = {
  slug: "agent-swarms",
  section: "agents",
  title: "Agent Swarms",
  tagline:
    "Review many files in parallel with copies of one agent that already knows your rules.",
  ideas: [
    "Forks are copy-on-write, so a hundred forks of a long conversation share one copy.",
    "Cap how many forks are alive, and discard each one when its file is done.",
    "Key every fork, so a retried fork can never make a second copy.",
  ],
  docs: "https://rivet.dev/guides/agent-swarms/",
  requires: [
    {
      label: "rivetkit 3.1+",
      detail: "client.agent.fork() and keyed forks arrive in 3.1.",
    },
    {
      label: "@rivet-dev/pi + @earendil-works/pi-durable",
      detail:
        "The durable agent loop. The guide also installs pi-ai and chord.",
    },
    {
      label: "ANTHROPIC_API_KEY",
      detail: "Every fork makes its own model calls on this key.",
    },
    {
      label: "No sandbox",
      detail: "Fork only agents without a sandbox. Forks would share it.",
    },
  ],
  nodes: [
    {
      id: "script",
      label: "swarm.ts",
      kind: "client",
      key: "your backend",
      x: 14,
      y: 14,
    },
    {
      id: "agent",
      label: "agent",
      kind: "agent",
      key: "code-review",
      x: 50,
      y: 14,
    },
    {
      id: "history",
      label: "history",
      kind: "store",
      key: "shared steps",
      x: 84,
      y: 14,
    },
    {
      id: "fork-a",
      label: "fork",
      kind: "fork",
      key: "review, auth.ts",
      x: 22,
      y: 46,
    },
    {
      id: "fork-b",
      label: "fork",
      kind: "fork",
      key: "review, db.ts",
      x: 50,
      y: 46,
    },
    {
      id: "fork-c",
      label: "fork",
      kind: "fork",
      key: "review, routes.ts",
      x: 78,
      y: 46,
    },
    {
      id: "fork-d",
      label: "fork",
      kind: "fork",
      key: "review, cache.ts",
      x: 22,
      y: 46,
    },
  ],
  edges: [
    { id: "script-agent", from: "script", to: "agent" },
    { id: "agent-history", from: "agent", to: "history", dashed: true },
    { id: "agent-fork-a", from: "agent", to: "fork-a", dashed: true },
    { id: "agent-fork-b", from: "agent", to: "fork-b", dashed: true },
    { id: "agent-fork-c", from: "agent", to: "fork-c", dashed: true },
    { id: "agent-fork-d", from: "agent", to: "fork-d", dashed: true },
    { id: "script-fork-a", from: "script", to: "fork-a" },
    { id: "script-fork-d", from: "script", to: "fork-d" },
  ],
  beats: [
    {
      title: "Give the agent its context.",
      body: "The script prompts one agent with the team's review rules. That turn is saved to the agent's history like any other.",
      enter: ["script", "agent", "history"],
      focus: ["agent"],
      status: { agent: "learning rules" },
      flows: [
        { edge: "script-agent", label: "prompt(rules)" },
        { edge: "agent-history", label: "save step" },
      ],
      panel: { kind: "chat", title: "agent · code-review", messages: rules },
    },
    {
      title: "Wait until it is idle.",
      body: "A turn in progress would be copied into every fork. The script waits for the agent to go idle, then resolves its id to fork from.",
      focus: ["script", "agent"],
      status: { agent: "idle" },
      flows: [{ edge: "script-agent", label: "harness.waitForIdle()" }],
      panel: {
        kind: "state",
        title: "agent · code-review",
        rows: [
          ["turns", "1 complete"],
          ["turn in progress", "none"],
          ["agentId", "resolved"],
          ["MAX_FORKS", "10"],
        ],
      },
    },
    {
      title: "Fork once per file.",
      body: "Each worker calls client.agent.fork with its own key. A fork shares the agent's saved steps instead of copying them, so it starts fast.",
      enter: ["fork-a", "fork-b", "fork-c"],
      focus: ["fork-a", "fork-b", "fork-c"],
      status: {
        agent: "idle",
        "fork-a": "forked",
        "fork-b": "forked",
        "fork-c": "forked",
      },
      flows: [
        { edge: "agent-fork-a", label: "fork" },
        { edge: "agent-fork-b", label: "fork" },
        { edge: "agent-fork-c", label: "fork" },
      ],
      panel: {
        kind: "terminal",
        title: "swarm.ts",
        lines: [
          { text: "npx tsx swarm.ts src/*.ts", tone: "command" },
          { text: "24 files, at most 10 forks alive", tone: "muted" },
          { text: 'fork ["review", runId, "src/auth.ts"]', tone: "event" },
          { text: 'fork ["review", runId, "src/db.ts"]', tone: "event" },
          { text: 'fork ["review", runId, "src/routes.ts"]', tone: "event" },
          { text: "…7 more", tone: "muted" },
        ],
      },
    },
    {
      title: "Each fork reviews one file.",
      body: "The fork already holds the review rules, so the prompt is just the file. It answers in one line. The original agent is never called.",
      focus: ["fork-a"],
      status: {
        agent: "idle",
        "fork-a": "reviewing",
        "fork-b": "reviewing",
        "fork-c": "reviewing",
      },
      flows: [{ edge: "script-fork-a", label: "prompt(auth.ts)" }],
      panel: {
        kind: "chat",
        title: "fork · review, auth.ts",
        messages: [
          ...ghostRules,
          { role: "user", text: "Review src/auth.ts in one line." },
          {
            role: "assistant",
            text: "verifyToken catches every error and returns null, which hides expired keys.",
            streaming: true,
          },
        ],
      },
    },
    {
      title: "Discard it and take the next file.",
      body: "The script keeps the one-line review and discards the fork in a finally block. A fork keeps its storage until it is destroyed.",
      exit: ["fork-a"],
      focus: ["script"],
      status: { agent: "idle", "fork-b": "reviewing", "fork-c": "reviewing" },
      flows: [{ edge: "script-fork-a", label: "discard()" }],
      panel: {
        kind: "terminal",
        title: "swarm.ts",
        lines: [
          {
            text: "src/auth.ts: verifyToken catches every error and returns null.",
            tone: "ok",
          },
          { text: "discard fork review, auth.ts", tone: "muted" },
          { text: "forks alive: 9 of 10", tone: "muted" },
          { text: "next file: src/cache.ts", tone: "event" },
        ],
      },
    },
    {
      title: "Retry when storage pushes back.",
      body: "Under load, storage can refuse a fork with depot.overloaded and a retry_after_ms hint. The client does not retry it, so the script waits that long with jitter. The key makes the retry safe.",
      enter: ["fork-d"],
      focus: ["fork-d"],
      status: {
        agent: "idle",
        "fork-b": "reviewing",
        "fork-c": "reviewing",
        "fork-d": "retried",
      },
      flows: [{ edge: "agent-fork-d", label: "fork (attempt 2)" }],
      panel: {
        kind: "terminal",
        title: "forkWithRetry",
        lines: [
          { text: 'fork ["review", runId, "src/cache.ts"]', tone: "command" },
          { text: "depot.overloaded  retry_after_ms: 200", tone: "error" },
          { text: "wait 287 ms (hint plus jitter)", tone: "muted" },
          { text: 'fork ["review", runId, "src/cache.ts"]', tone: "command" },
          { text: "created", tone: "ok" },
          {
            text: "duplicate_key or fork_pending would mean it exists: use it",
            tone: "muted",
          },
        ],
      },
    },
    {
      title: "Summarize on the original.",
      body: "When every file has a review, the forks are gone. The script sends all the reviews to the original agent, so the summary lands in its own history.",
      exit: ["fork-b", "fork-c", "fork-d"],
      focus: ["agent", "history"],
      status: { agent: "summarizing" },
      flows: [
        { edge: "script-agent", label: "prompt(reviews)" },
        { edge: "agent-history", label: "save step" },
      ],
      panel: {
        kind: "chat",
        title: "agent · code-review",
        messages: [
          ...rules,
          {
            role: "user",
            text: "One-line reviews of every file: src/auth.ts … src/cache.ts. Summarize the biggest risks.",
          },
          {
            role: "assistant",
            text: "Two risks stand out: auth.ts hides token errors, and db.ts retries writes without a limit.",
            streaming: true,
          },
        ],
      },
    },
  ],
  code: [
    {
      name: "server.ts",
      note: "One plain Pi agent with a discard action each fork can call.",
      source: `import { createRegistry } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";

export const agent = pi({
  model: "anthropic/claude-opus-5-5",
  registry: createRegistry(),
  actions: {
    discard: (c) => {
      c.destroy();
    },
  },
});

export const registry = setup({ use: { agent } });

registry.start();`,
    },
    {
      name: "swarm.ts",
      note: "Load the rules once, fork per file with a cap, summarize on the original.",
      source: `const client = createClient<typeof registry>();

// How many forks may be alive at once. Each fork is a running agent.
const MAX_FORKS = 10;

const files = process.argv.slice(2);
const agent = client.agent.getOrCreate(["code-review"]);
await agent.prompt(
  "You review TypeScript for our team. We care about error handling and clear names.",
  { requestId: crypto.randomUUID() },
);

// A turn in progress would be copied into every fork, so fork an idle agent.
await agent.harness.waitForIdle();
const agentId = await agent.resolve();

// One key per fork makes a retried fork safe: it can never make a second copy.
const runId = crypto.randomUUID();

const reports = await mapWithLimit(files, MAX_FORKS, async (path) => {
  const fork = await forkWithRetry(agentId, ["review", runId, path]);
  try {
    const source = await readFile(path, "utf8");
    const result = await fork.prompt(\`Review \${path} in one line.\\n\\n\${source}\`, {
      requestId: \`review:\${runId}:\${path}\`,
    });
    const line = result.status === "done" ? result.text?.split("\\n")[0] : result.reason;
    return \`\${path}: \${line ?? "no review"}\`;
  } finally {
    await fork.discard();
  }
});

// The summary is a normal turn, so it lands in the agent's conversation.
const summary = await agent.prompt(
  \`One-line reviews of every file:\\n\${reports.join("\\n")}\\n\\nSummarize the biggest risks.\`,
  { requestId: crypto.randomUUID() },
);
// … mapWithLimit runs at most MAX_FORKS workers, keeping order.`,
    },
    {
      name: "fork-with-retry.ts",
      note: "Reuse a fork that already exists, and wait out overload refusals.",
      source: `/** Forks the agent, waiting and retrying when storage asks the caller to slow down. */
async function forkWithRetry(sourceId: string, key: string[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.agent.fork(sourceId, { key });
    } catch (error) {
      if (!(error instanceof ActorError)) throw error;

      // The fork exists: an earlier attempt made it, or its copy is still running.
      if (
        error.group === "actor" &&
        (error.code === "duplicate_key" || error.code === "fork_pending")
      ) {
        return client.agent.get(key);
      }

      // Refused before any work. Wait as long as asked, with jitter.
      const overloaded = error.group === "depot" && error.code === "overloaded";
      if (!overloaded || attempt >= 5) throw error;
      const metadata = error.metadata as { retry_after_ms?: number } | undefined;
      const waitMs = (metadata?.retry_after_ms ?? 200) * (1 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}`,
    },
  ],
};
