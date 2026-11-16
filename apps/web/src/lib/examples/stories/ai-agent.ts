import type { ChatLine, ExampleStory } from "../types";

const first: ChatLine = {
  role: "user",
  text: "Draft a handoff note for the Q3 launch.",
};
const reply =
  "Q3 launch handoff: scope is frozen, two blockers remain (billing copy, SSO docs), owners listed below.";

export const aiAgent: ExampleStory = {
  slug: "ai-agent",
  section: "agents",
  title: "AI Agent",
  tagline:
    "Run a streaming chat agent where each conversation keeps its own memory and answers in order.",
  ideas: [
    "One Actor per conversation. Its SQLite database is the memory, with no external database.",
    "A message is saved as pending before any model call, and one drain answers pending messages in order.",
    "The save-reply transaction moves a message and its reply into the transcript together, so nothing is answered twice.",
  ],
  docs: "https://rivet.dev/guides/ai-agent/",
  requires: [
    {
      label: "rivetkit",
      detail:
        "Actors, rivetkit/db SQLite, events, and keepAwake. No Pi. This repo targets 3.1.1.",
    },
    {
      label: "ai + @ai-sdk/openai",
      detail: "The Vercel AI SDK's streamText drives the model call.",
    },
    {
      label: "OPENAI_API_KEY",
      detail:
        "The example calls gpt-4o-mini. Swap the AI SDK provider to use another.",
    },
  ],
  nodes: [
    { id: "client", label: "browser", kind: "client", x: 14, y: 30 },
    {
      id: "manager",
      label: "agentManager",
      kind: "actor",
      key: "primary",
      x: 40,
      y: 11,
    },
    {
      id: "agent",
      label: "agent",
      kind: "agent",
      key: "agent-18f…",
      x: 52,
      y: 30,
    },
    {
      id: "llm",
      label: "OpenAI",
      kind: "service",
      key: "gpt-4o-mini",
      x: 84,
      y: 16,
    },
    {
      id: "pending",
      label: "pending_messages",
      kind: "store",
      key: "SQLite",
      x: 32,
      y: 49,
    },
    {
      id: "messages",
      label: "messages",
      kind: "store",
      key: "SQLite",
      x: 72,
      y: 49,
    },
  ],
  edges: [
    { id: "client-manager", from: "client", to: "manager" },
    { id: "manager-agent", from: "manager", to: "agent" },
    { id: "client-agent", from: "client", to: "agent" },
    { id: "agent-llm", from: "agent", to: "llm" },
    { id: "agent-pending", from: "agent", to: "pending", dashed: true },
    { id: "agent-messages", from: "agent", to: "messages", dashed: true },
    { id: "pending-messages", from: "pending", to: "messages" },
  ],
  beats: [
    {
      title: "Create a conversation.",
      body: "createAgent saves an AgentInfo record on the agentManager singleton. It then calls getOrCreate and getStatus on the new agent, so the conversation Actor exists before the client connects.",
      enter: ["client", "manager", "agent"],
      focus: ["manager", "agent"],
      status: { agent: "idle" },
      flows: [
        { edge: "client-manager", label: "createAgent(name)" },
        { edge: "manager-agent", label: "getStatus()" },
      ],
      panel: {
        kind: "state",
        title: "agentManager · primary · agents",
        rows: [
          ["id", "agent-18f…"],
          ["name", "Agent 1"],
          ["created_at", "saved"],
        ],
      },
    },
    {
      title: "Save before answering.",
      body: "sendMessage inserts the message into pending_messages, broadcasts messageAdded, and starts the drain. The message is durable once the insert resolves, before any model call.",
      enter: ["pending"],
      focus: ["client", "agent", "pending"],
      status: { agent: "pending 1" },
      flows: [
        { edge: "client-agent", label: "sendMessage({ text, sender })" },
        { edge: "agent-pending", label: "INSERT" },
      ],
      panel: {
        kind: "state",
        title: "pending_messages",
        rows: [
          ["seq 1", "Draft a handoff note for the Q3 launch."],
          ["sender", "Operator"],
        ],
      },
    },
    {
      title: "One drain, oldest first.",
      body: "Only one drain runs per Actor, so a conversation has at most one model call in flight. It rebuilds the prompt from the system prompt, the saved messages, and the oldest pending one.",
      enter: ["llm"],
      focus: ["agent", "llm"],
      status: { agent: "thinking" },
      flows: [
        { edge: "agent-pending", label: "SELECT … LIMIT 1" },
        { edge: "agent-llm", label: "streamText()" },
      ],
      panel: {
        kind: "state",
        title: "agent · c.vars",
        rows: [
          ["status", "thinking"],
          ["draining", "Promise (one at a time)"],
          ["reply", "assistant-19a…, replyTo user-18f…"],
          ["abortSignal", "from onWake's context"],
        ],
      },
    },
    {
      title: "Stream every delta.",
      body: "Each text delta becomes a response event with messageId, delta, cumulative content, and done. The client replaces the message by messageId, which tolerates a dropped event.",
      focus: ["agent", "client"],
      status: { agent: "streaming" },
      flows: [
        { edge: "agent-llm", label: "textStream", back: true },
        {
          edge: "client-agent",
          label: "response { delta, done: false }",
          back: true,
        },
      ],
      panel: {
        kind: "chat",
        title: "browser · agent-18f…",
        messages: [
          first,
          { role: "assistant", text: reply.slice(0, 58), streaming: true },
        ],
      },
    },
    {
      title: "Save the reply in one transaction.",
      body: "save-reply inserts the user message and the reply into messages and deletes the pending entry, all at once. Then a last response event goes out with done: true.",
      enter: ["messages"],
      focus: ["pending", "messages"],
      status: { agent: "idle" },
      flows: [{ edge: "pending-messages", label: "save-reply" }],
      panel: {
        kind: "state",
        title: "agent SQLite",
        rows: [
          ["messages", "2 rows (user + assistant)"],
          ["pending_messages", "0 rows"],
          ["response", '{ delta: "", content, done: true }'],
        ],
      },
    },
    {
      title: "Shutdown mid-reply.",
      body: "A second message is streaming when the Actor shuts down. The abort signal cancels streamText, the partial reply is not saved, and the message stays pending.",
      focus: ["agent", "pending"],
      status: { agent: "stopped" },
      panel: {
        kind: "terminal",
        title: "agent-18f…",
        lines: [
          { text: "sendMessage → pending seq 2", tone: "event" },
          { text: "streamText … 41 tokens", tone: "muted" },
          { text: "shutdown: c.abortSignal fired", tone: "error" },
          { text: "partial reply discarded", tone: "muted" },
          { text: "pending_messages: 1 row", tone: "ok" },
        ],
      },
    },
    {
      title: "onWake answers it again.",
      body: "onWake runs on every start and calls c.vars.startDrain. The pending message is answered again from the beginning, and getHistory shows a client the reply so far.",
      focus: ["agent", "pending", "llm"],
      status: { agent: "thinking" },
      flows: [
        { edge: "agent-pending", label: "SELECT … LIMIT 1" },
        { edge: "agent-llm", label: "streamText()" },
      ],
      panel: {
        kind: "terminal",
        title: "agent-18f…",
        lines: [
          { text: "onWake", tone: "command" },
          { text: "c.vars.startDrain = () => startDrain(c)", tone: "muted" },
          { text: "drain: pending seq 2", tone: "event" },
          { text: "streamText from the start", tone: "event" },
          { text: "save-reply committed", tone: "ok" },
        ],
      },
    },
  ],
  code: [
    {
      name: "index.ts (actor)",
      note: "sendMessage saves first. onWake owns every drain.",
      source: `export const agent = actor({
  // Messages are saved in the actor's SQLite database, which survives restarts
  db: db({ onMigrate: async (db) => { /* … messages, pending_messages */ } }),
  createVars: (): AgentVars => ({ /* … status, reply, pending, draining, startDrain */ }),
  events: {
    messageAdded: event<AgentMessage>(),
    status: event<AgentStatus>(),
    response: event<AgentResponseEvent>(),
  },

  // \`onWake\` runs on every start, so messages that were still pending when
  // the actor last slept or crashed get answered
  onWake: (c) => {
    // Drains run on this context because an action's \`c.abortSignal\` stops
    // firing on shutdown once that action returns.
    c.vars.startDrain = () => startDrain(c);
    c.vars.startDrain();
  },

  actions: {
    sendMessage: async (c, input: AgentMessageInput) => {
      const text = typeof input?.text === "string" ? input.text.trim() : "";
      if (!text) {
        throw new UserError("Message text is required");
      }
      const userMessage: AgentMessage = { /* … id, role, sender, content, createdAt */ };

      // The message is durable once this insert resolves. The drain
      // answers it after every message that arrived before it.
      await c.db.execute(
        "INSERT INTO pending_messages (id, sender, content, created_at) VALUES (?, ?, ?, ?)",
        userMessage.id, userMessage.sender, userMessage.content, userMessage.createdAt,
      );
      c.broadcast("messageAdded", userMessage);

      c.vars.startDrain();
      return userMessage;
    },
    getHistory: (c): Promise<AgentMessage[]> => readHistory(c),
    getStatus: (c) => c.vars.status,
  },
});`,
    },
    {
      name: "index.ts (drain)",
      note: "One drain at a time, streamed deltas, and the save-reply transaction.",
      source: `function startDrain(c: ActorContextOf<typeof agent>): void {
  c.vars.pending = true;
  if (c.vars.draining) {
    return;
  }
  c.vars.draining = c
    .keepAwake(answerPendingMessages(c))
    .catch((error) => {
      // The message stays pending and is answered on the next drain
      c.log.error({ msg: "failed to answer message", error });
    })
    .finally(() => {
      c.vars.draining = null;
      // Catch messages that arrived after the drain last checked \`pending\`
      if (c.vars.pending && !c.aborted) {
        startDrain(c);
      }
    });
}

// … in answerMessage, for the oldest pending message:
const result = await streamText({
  model: openai("gpt-4o-mini"),
  messages: promptMessages,
  // Shutdown cancels the model call
  abortSignal: c.abortSignal,
});
let content = "";
for await (const delta of result.textStream) {
  content += delta;
  assistantMessage.content = content;
  c.broadcast("response", { messageId: assistantMessage.id, delta, content, done: false });
}
// A reply cut short by shutdown is not saved
if (c.aborted) {
  return;
}

// … in saveReply: move a pending message and its reply into the transcript atomically.
await c.db.transaction(async (tx) => {
  await saveMessage(tx, userMessage);
  await saveMessage(tx, assistantMessage);
  await tx.execute("DELETE FROM pending_messages WHERE id = ?", userMessage.id);
}, { name: "save-reply" });`,
    },
  ],
};
