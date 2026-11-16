import type { ExampleStory } from "../types";

const history = [
  { role: "user", text: "Plan a 5-day Lisbon trip for two." },
  {
    role: "assistant",
    text: "Day 1 — Alfama walk, Castelo de São Jorge, fado dinner…",
  },
] as const;

export const sideQuestions: ExampleStory = {
  slug: "side-questions",
  section: "agents",
  title: "Side Questions (/btw)",
  tagline:
    "Ask a busy agent a quick question without interrupting it or adding to its history.",
  ideas: [
    "A fork is a copy-on-write copy of an agent up to its last saved step.",
    "Forking never calls the original agent. It keeps working.",
    "The fork answers once and is destroyed. Nothing leaks back.",
  ],
  docs: "https://rivet.dev/guides/side-questions/",
  requires: [
    {
      label: "rivetkit 3.1+",
      detail: "fork(), onFork, and forkChain arrive in 3.1.",
    },
    {
      label: "@rivet-dev/pi",
      detail: "The durable agent loop that both copies run.",
    },
    {
      label: "ANTHROPIC_API_KEY",
      detail: "Or any model provider Pi supports.",
    },
  ],
  nodes: [
    { id: "you", label: "You", kind: "client", x: 14, y: 30 },
    {
      id: "agent",
      label: "agent",
      kind: "agent",
      key: "trip-42",
      x: 50,
      y: 18,
    },
    {
      id: "fork",
      label: "side fork",
      kind: "fork",
      key: "no key",
      x: 50,
      y: 46,
    },
    {
      id: "store",
      label: "history",
      kind: "store",
      key: "SQLite",
      x: 84,
      y: 18,
    },
  ],
  edges: [
    { id: "you-agent", from: "you", to: "agent" },
    { id: "agent-store", from: "agent", to: "store", dashed: true },
    { id: "agent-fork", from: "agent", to: "fork", dashed: true },
    { id: "you-fork", from: "you", to: "fork" },
  ],
  beats: [
    {
      title: "The agent is busy.",
      body: "You asked for a five-day plan. The agent is halfway through writing it, saving each step to its own history.",
      enter: ["you", "agent", "store"],
      focus: ["agent"],
      status: { agent: "writing day 3" },
      flows: [{ edge: "agent-store", label: "save step" }],
      panel: {
        kind: "chat",
        title: "agent · trip-42",
        messages: [
          ...history,
          {
            role: "assistant",
            text: "Day 3 — Belém, pastéis, LX Factory",
            streaming: true,
          },
        ],
      },
    },
    {
      title: "You type /btw.",
      body: "You want to know if it rains in May. Sending that to the agent would interrupt the plan and leave a stray question in its history.",
      focus: ["you"],
      status: { agent: "writing day 3" },
      panel: {
        kind: "chat",
        title: "your screen",
        messages: [
          ...history,
          { role: "user", text: "/btw does it rain much in Lisbon in May?" },
        ],
      },
    },
    {
      title: "Fork the agent.",
      body: "client.agent.fork(id) makes a copy that shares every saved step. Nothing is copied up front, and the original agent is never called.",
      enter: ["fork"],
      focus: ["fork"],
      status: { agent: "writing day 4", fork: "forked" },
      flows: [{ edge: "agent-fork", label: "copy-on-write" }],
      panel: {
        kind: "chat",
        title: "side fork",
        messages: history.map((line) => ({ ...line, ghost: true })),
      },
    },
    {
      title: "Stop the copied turn.",
      body: "The fork inherited the half-written answer. Aborting it in the fork stops only the copy. The original keeps writing.",
      focus: ["fork"],
      status: { agent: "writing day 4", fork: "aborted copy" },
      flows: [{ edge: "you-fork", label: "abort(root)" }],
      panel: {
        kind: "chat",
        title: "side fork",
        messages: [
          ...history.map((line) => ({ ...line, ghost: true })),
          { role: "system", text: "Copied turn stopped in this fork only." },
        ],
      },
    },
    {
      title: "Ask the fork.",
      body: "The fork already knows the whole trip, so it can answer in context. The original agent never sees the question.",
      focus: ["fork", "you"],
      status: { agent: "writing day 5", fork: "answering" },
      flows: [{ edge: "you-fork", label: "prompt(btw)" }],
      panel: {
        kind: "chat",
        title: "side fork",
        messages: [
          ...history.map((line) => ({ ...line, ghost: true })),
          { role: "user", text: "btw, does it rain much in Lisbon in May?" },
          {
            role: "assistant",
            text: "Rarely — about 5 rainy days. Your Belém day is outdoors, so it is a safe pick.",
            streaming: true,
          },
        ],
      },
    },
    {
      title: "Discard the fork.",
      body: "You show the answer, then destroy the fork. onFork also schedules a discard after ten minutes, in case the client never comes back.",
      exit: ["fork"],
      focus: ["you"],
      status: { agent: "writing day 5" },
      flows: [{ edge: "you-fork", label: "discard()" }],
      panel: {
        kind: "chat",
        title: "your screen",
        messages: [
          ...history,
          { role: "user", text: "/btw does it rain much in Lisbon in May?" },
          {
            role: "assistant",
            text: "Rarely — about 5 rainy days. Belém is a safe pick.",
          },
        ],
      },
    },
    {
      title: "The plan finishes untouched.",
      body: "The agent's history has the plan and nothing else. The side question lived and died in its own copy.",
      focus: ["agent", "store"],
      status: { agent: "done" },
      flows: [{ edge: "agent-store", label: "save step" }],
      panel: {
        kind: "state",
        title: "agent history",
        rows: [
          ["messages", "2 → 2 (no side question)"],
          ["turns", "1 complete"],
          ["forks alive", "0"],
        ],
      },
    },
  ],
  code: [
    {
      name: "agent.ts",
      note: "onFork marks the copy and schedules its own cleanup.",
      source: `import { pi } from "@rivet-dev/pi";
import { z } from "zod";

const SideInput = z.object({ kind: z.literal("btw") });

export const agent = pi({
  model: "anthropic/claude-opus-5-5",
  onFork: async (c, fork) => {
    if (!SideInput.safeParse(fork.input).success) return;
    // Safety net: a side fork never outlives ten minutes.
    await c.schedule.after(10 * 60_000, "discard");
  },
  actions: {
    discard: (c) => c.destroy(),
  },
});`,
    },
    {
      name: "btw.ts",
      note: "Fork, stop the copied turn, ask, and always discard.",
      source: `import { ROOT_CONVERSATION_ID } from "@earendil-works/chord/context";

export async function btw(agentId: string, question: string) {
  const side = await client.agent.fork(agentId, {
    input: { kind: "btw" },
  });
  try {
    // The fork copied the turn in progress. Stop it here only.
    await side.conversation.abort(ROOT_CONVERSATION_ID);
    const result = await side.prompt(\`btw, \${question}\`, {
      requestId: crypto.randomUUID(),
    });
    return result.status === "done" ? (result.text ?? "") : "No answer.";
  } finally {
    await side.discard();
  }
}`,
    },
  ],
};
