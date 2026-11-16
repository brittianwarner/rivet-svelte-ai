import type { ChatLine, ExampleStory } from "../types";

const shared: ChatLine[] = [
  { role: "user", text: "Plan a three-day trip to Lisbon." },
  {
    role: "assistant",
    text: "Day 1: Alfama and the castle. Day 2: Belém. Day 3: Chiado and a fado dinner.",
  },
];
const ghost = shared.map((line) => ({ ...line, ghost: true }));

export const branchConversations: ExampleStory = {
  slug: "branch-conversations",
  section: "agents",
  title: "Branch Conversations (/fork)",
  tagline:
    "Try another direction in a conversation without losing the current one.",
  ideas: [
    "Each thread is one Pi agent. Branching a thread is a fork of that agent with a new key.",
    "The branch starts with the whole history. The shared part is stored once.",
    "After the fork, each thread keeps its own messages. c.forkChain names the parent.",
  ],
  docs: "https://rivet.dev/guides/branch-conversations/",
  requires: [
    {
      label: "rivetkit 3.1+",
      detail: "fork() and c.forkChain arrive in 3.1. This repo targets 3.1.1.",
    },
    {
      label: "@rivet-dev/pi",
      detail:
        "With @earendil-works/pi-durable, pi-ai, and chord. One agent per thread.",
    },
    {
      label: "ANTHROPIC_API_KEY",
      detail: "The agent runs on anthropic/claude-opus-5-5.",
    },
    {
      label: "No sandbox",
      detail:
        "A fork of an agent with a sandbox would share that sandbox with its source.",
    },
  ],
  nodes: [
    { id: "you", label: "You", kind: "client", x: 14, y: 30 },
    {
      id: "main",
      label: "main thread",
      kind: "agent",
      key: "thread, main",
      x: 48,
      y: 14,
    },
    {
      id: "branch",
      label: "branch",
      kind: "fork",
      key: "thread, 3f9a…",
      x: 48,
      y: 46,
    },
    {
      id: "store",
      label: "history",
      kind: "store",
      key: "shared, stored once",
      x: 82,
      y: 30,
    },
  ],
  edges: [
    { id: "you-main", from: "you", to: "main" },
    { id: "you-branch", from: "you", to: "branch" },
    { id: "main-branch", from: "main", to: "branch", dashed: true },
    { id: "main-store", from: "main", to: "store", dashed: true },
    { id: "branch-store", from: "branch", to: "store", dashed: true },
  ],
  beats: [
    {
      title: "Plan in the main thread.",
      body: "The client gets the agent keyed by the main thread and prompts it. Pi saves each step as it goes.",
      enter: ["you", "main", "store"],
      focus: ["you", "main"],
      status: { main: "answering" },
      flows: [
        { edge: "you-main", label: "prompt(text, { requestId })" },
        { edge: "main-store", label: "save step" },
      ],
      panel: { kind: "chat", title: "main thread", messages: shared },
    },
    {
      title: "Type /fork.",
      body: "client.agent.fork gives the branch the main thread's whole history, without copying it, and a key of its own. The main thread is not called.",
      enter: ["branch"],
      focus: ["main", "branch"],
      status: { main: "idle", branch: "forked" },
      flows: [{ edge: "main-branch", label: "fork(id, { key })" }],
      panel: { kind: "chat", title: "branch · thread, 3f9a…", messages: ghost },
    },
    {
      title: "Stop the copied turn.",
      body: "If the main thread was mid-turn, the branch copied that turn too. Aborting it in the branch leaves only the original to finish it.",
      focus: ["branch"],
      status: { branch: "aborted copy" },
      flows: [{ edge: "you-branch", label: "conversation.abort(ROOT)" }],
      panel: {
        kind: "chat",
        title: "branch · thread, 3f9a…",
        messages: [
          ...ghost,
          { role: "system", text: "Copied turn stopped in this branch only." },
        ],
      },
    },
    {
      title: "Take the branch elsewhere.",
      body: "You keep working in the branch. It already knows the trip, so the new request needs no restating.",
      focus: ["you", "branch"],
      status: { branch: "answering" },
      flows: [{ edge: "you-branch", label: 'prompt("tight budget")' }],
      panel: {
        kind: "chat",
        title: "branch · thread, 3f9a…",
        messages: [
          ...ghost,
          { role: "user", text: "Redo the plan on a tight budget." },
          {
            role: "assistant",
            text: "Day 1: free walking tour of Alfama. Day 2: tram 15 to Belém, pastéis for lunch…",
            streaming: true,
          },
        ],
      },
    },
    {
      title: "The main thread goes on.",
      body: "The main thread takes its own next turn. The branch never sees it.",
      focus: ["you", "main"],
      status: { main: "answering", branch: "idle" },
      flows: [{ edge: "you-main", label: 'prompt("add Sintra")' }],
      panel: {
        kind: "chat",
        title: "main thread",
        messages: [
          ...shared,
          { role: "user", text: "Add a day trip to Sintra." },
          {
            role: "assistant",
            text: "Day 4: train to Sintra, Pena Palace in the morning…",
            streaming: true,
          },
        ],
      },
    },
    {
      title: "History is stored once.",
      body: "Each thread stores only the messages it writes after the fork. A branch costs what it adds.",
      focus: ["main", "branch", "store"],
      status: { main: "idle", branch: "idle" },
      flows: [
        { edge: "main-store", label: "save step" },
        { edge: "branch-store", label: "save step" },
      ],
      panel: {
        kind: "state",
        title: "storage",
        rows: [
          ["shared history", "2 messages, stored once"],
          ["main adds", "Sintra turn"],
          ["branch adds", "budget turn"],
          ["copied at fork", "nothing"],
        ],
      },
    },
    {
      title: "Find the parent.",
      body: "Reopen the branch by its key and call parent, which reads c.forkChain. Keep your own list of threads, because a fork is not listed under its source.",
      focus: ["you", "branch"],
      flows: [{ edge: "you-branch", label: "parent()" }],
      panel: {
        kind: "terminal",
        title: "client.ts",
        lines: [
          {
            text: 'client.agent.get(["thread", "3f9a…"]).parent()',
            tone: "command",
          },
          { text: "→ c.forkChain.at(-1)?.actorId", tone: "muted" },
          { text: "the main thread's actor ID", tone: "ok" },
        ],
      },
    },
  ],
  code: [
    {
      name: "server.ts",
      note: "parent reads the fork chain. The last entry is the source thread.",
      source: `import { createRegistry } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";

export const agent = pi({
  model: "anthropic/claude-opus-5-5",
  registry: createRegistry(),
  actions: {
    // The thread this one branched from, or null for an original thread.
    parent: (c) => c.forkChain.at(-1)?.actorId ?? null,
  },
});

export const registry = setup({ use: { agent } });

registry.start();`,
    },
    {
      name: "client.ts",
      note: "Fork with a new key, stop the copied turn, then use both threads.",
      source: `import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();

async function say(thread: ReturnType<typeof client.agent.get>, text: string) {
  const result = await thread.prompt(text, { requestId: crypto.randomUUID() });
  console.log(result.status === "done" ? result.text : \`No answer: \${result.reason}\`);
}

const main = client.agent.getOrCreate(["thread", "main"]);
await say(main, "Plan a three-day trip to Lisbon.");

// /fork: branch the conversation into a new thread with its own key.
const branchKey = ["thread", crypto.randomUUID()];
const branch = await client.agent.fork(await main.resolve(), { key: branchKey });

// A turn the original was in the middle of is copied too. Stop it in the
// branch, so only the original thread finishes it.
await branch.conversation.abort(ROOT_CONVERSATION_ID);

await say(branch, "Redo the plan on a tight budget.");

// The original thread goes on separately.
await say(main, "Add a day trip to Sintra.");

// Later, reopen the branch by its key.
const reopened = client.agent.get(branchKey);
console.log(await reopened.parent()); // the main thread's actor ID`,
    },
  ],
};
