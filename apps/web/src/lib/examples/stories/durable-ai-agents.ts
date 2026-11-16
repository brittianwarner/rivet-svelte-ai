import type { ChatLine, ExampleStory } from "../types";

const ask: ChatLine = {
  role: "user",
  text: "Find me a flight from SFO to HND on December 10, then book the cheaper one for Ada Lovelace.",
};
const offer: ChatLine = {
  role: "assistant",
  text: "SFO-HND-0810 departs 08:10 for $1240. SFO-HND-1355 departs 13:55 for $980. Book the 13:55 for Ada Lovelace?",
};
const confirm: ChatLine = { role: "user", text: "Yes, book it." };
const booked: ChatLine = {
  role: "assistant",
  text: "Booked Ada Lovelace on SFO-HND-1355. Confirmation 7C41E9.",
};

export const durableAiAgents: ExampleStory = {
  slug: "durable-ai-agents",
  section: "agents",
  title: "Durable AI Agents",
  tagline:
    "Keep an agent's answer, plan, and tool calls through a crash, without booking anything twice.",
  ideas: [
    "Pi saves each model call and tool call to the Actor's SQLite database before the next one starts.",
    "A tool that changes something memoizes its idempotency key, so a rerun after a crash books once.",
    "The run never depends on the client. A reload or restart picks the answer back up.",
  ],
  docs: "https://rivet.dev/guides/durable-ai-agents/",
  requires: [
    {
      label: "@rivet-dev/pi",
      detail:
        "With @earendil-works/pi-durable, pi-ai, pi-schema, and chord for the agent, tools, and view deltas.",
    },
    {
      label: "rivetkit",
      detail: "Actors, the registry, and the client. This repo targets 3.1.1.",
    },
    {
      label: "ANTHROPIC_API_KEY",
      detail: "The agent runs on anthropic/claude-opus-5-5.",
    },
    {
      label: "Your travel API",
      detail:
        "The guide ships mocks. A real API must return the first booking when it sees the same idempotency key.",
    },
  ],
  nodes: [
    { id: "client", label: "chat client", kind: "client", x: 14, y: 30 },
    {
      id: "agent",
      label: "chatAgent",
      kind: "agent",
      key: "trip-1",
      x: 48,
      y: 22,
    },
    {
      id: "store",
      label: "SQLite",
      kind: "store",
      key: "steps + plan",
      x: 48,
      y: 48,
    },
    {
      id: "llm",
      label: "LLM provider",
      kind: "service",
      key: "anthropic",
      x: 84,
      y: 12,
    },
    {
      id: "api",
      label: "travel API",
      kind: "service",
      key: "your API",
      x: 84,
      y: 38,
    },
  ],
  edges: [
    { id: "client-agent", from: "client", to: "agent" },
    { id: "agent-store", from: "agent", to: "store", dashed: true },
    { id: "agent-llm", from: "agent", to: "llm" },
    { id: "agent-api", from: "agent", to: "api" },
  ],
  beats: [
    {
      title: "One agent per conversation.",
      body: "The client connects to chatAgent keyed by the conversation id and watches its view. submit saves the message and returns without waiting for the answer.",
      enter: ["client", "agent", "store"],
      focus: ["client", "agent"],
      status: { agent: "answering" },
      flows: [{ edge: "client-agent", label: "submit(text, { requestId })" }],
      panel: { kind: "chat", title: "chat client · trip-1", messages: [ask] },
    },
    {
      title: "Save a plan, then search.",
      body: "The model saves a plan with update_plan, then calls search_flights. Each step lands in SQLite before the next one starts.",
      enter: ["llm", "api"],
      focus: ["agent", "store", "api"],
      status: { agent: "search_flights" },
      flows: [
        { edge: "agent-store", label: "save step" },
        { edge: "agent-api", label: "search_flights" },
      ],
      panel: {
        kind: "state",
        title: "travel.plan · harness.snapshot",
        rows: [
          ["[x]", "Search SFO to HND on Dec 10"],
          ["[ ]", "Confirm the cheaper flight"],
          ["[ ]", "Book it for Ada Lovelace"],
        ],
      },
    },
    {
      title: "Confirm, then book.",
      body: "You confirm. book_flight saves an idempotency key with api.memo before it calls your API, so the key is on disk first.",
      focus: ["agent", "store"],
      status: { agent: "book_flight" },
      flows: [
        { edge: "client-agent", label: 'submit("Yes, book it.")' },
        { edge: "agent-store", label: "memo(idempotency-key)" },
      ],
      panel: {
        kind: "chat",
        title: "chat client · trip-1",
        messages: [ask, offer, confirm],
      },
    },
    {
      title: "Kill the worker mid-call.",
      body: "The booking request reaches your API, then the worker dies before the result is saved. The client loses its connection.",
      focus: ["agent", "api"],
      status: { agent: "killed", api: "booked once" },
      flows: [{ edge: "agent-api", label: "createBooking(key 7c41e9…)" }],
      panel: {
        kind: "terminal",
        title: "worker",
        lines: [
          { text: "> book_flight", tone: "event" },
          { text: "pkill -9 -f server.ts", tone: "command" },
          { text: "worker killed", tone: "error" },
          { text: "client: connection lost", tone: "muted" },
        ],
      },
    },
    {
      title: "Wake from SQLite.",
      body: "The worker starts again and the agent carries on with the same run. The client gets a pi.view frame with a new value and prints resumed.",
      focus: ["agent", "store", "client"],
      status: { agent: "resumed" },
      flows: [
        { edge: "agent-store", label: "load saved steps", back: true },
        { edge: "client-agent", label: "pi.view { value }", back: true },
      ],
      panel: {
        kind: "terminal",
        title: "client.ts trip-1",
        lines: [
          { text: "npx tsx server.ts", tone: "command" },
          { text: "chatAgent trip-1 woke from SQLite", tone: "event" },
          { text: "[resumed]", tone: "ok" },
          { text: "> book_flight", tone: "event" },
        ],
      },
    },
    {
      title: "The API books once.",
      body: 'book_flight is replay: "safe", so it runs again. api.memo returns the same key, and your API returns the first booking instead of a second seat.',
      focus: ["agent", "api"],
      status: { agent: "book_flight", api: "same booking" },
      flows: [{ edge: "agent-api", label: "createBooking(same key)" }],
      panel: {
        kind: "state",
        title: "book_flight · rerun",
        rows: [
          ["idempotency-key", "7c41e9d2-… (memoized)"],
          ["runs of the tool", "2"],
          ["seats booked", "1"],
          ["confirmation", "7C41E9"],
        ],
      },
    },
    {
      title: "Reload and see it all.",
      body: "Run the client again with trip-1. conversation.watch returns the newest entries and any answer in progress, including the booking, made once.",
      focus: ["client", "agent"],
      status: { agent: "idle" },
      flows: [{ edge: "client-agent", label: "conversation.watch(root.id)" }],
      panel: {
        kind: "chat",
        title: "chat client · trip-1 (reloaded)",
        messages: [ask, offer, confirm, booked],
      },
    },
  ],
  code: [
    {
      name: "tools.ts",
      note: "The memoized key makes a rerun after a crash book once.",
      source: `export const bookFlight = defineTool({
  name: "book_flight",
  description: "Book a seat on a flight. Only call this after the user confirms the flight.",
  parameters: obj({ flightId: str(), passenger: str() }),
  // After a crash this runs again with the same idempotency key, so the API books only once.
  replay: "safe",
  execute: async ({ flightId, passenger }, api, context) => {
    // The memo is saved with this tool call before the booking, so a rerun gets the same key.
    const idempotencyKey = await api.memo("idempotency-key", crypto.randomUUID(), context);
    const booking = await createBooking(flightId, passenger, idempotencyKey);
    const text = \`Booked \${passenger} on \${flightId}. Confirmation \${booking.confirmation}.\`;
    return { output: [{ type: "text", text }], details: booking };
  },
});

// Your API should return the first booking again when it sees the same idempotency key.
async function createBooking(flightId: string, passenger: string, idempotencyKey: string) {
  return { flightId, passenger, confirmation: idempotencyKey.slice(0, 6).toUpperCase() };
}`,
    },
    {
      name: "client.ts",
      note: "A pi.view frame with a value means the agent restarted. Keep streaming.",
      source: `import { createInterface } from "node:readline";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { PiViewFrame } from "@rivet-dev/pi";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

// Run with the same conversation id again to reopen it, like a reload.
const conversationId = process.argv[2] ?? crypto.randomUUID();
const client = createClient<typeof registry>();
const conn = client.chatAgent.getOrCreate([conversationId]).connect();

let view: ConversationView | undefined;
// Operations that arrive before the watch call returns.
const early: Op[] = [];

conn.on("pi.view", (frame) => {
  const { value, ops = [] } = frame as PiViewFrame;
  // A value replaces everything, such as when the agent restarts after a crash.
  if (value) {
    console.log("\\n[resumed]");
    view = value;
  } else if (view) view = applyImmutable(view, ops);
  else early.push(...ops);
  if (view) show(view);
});
// … show() prints the answer text it has not printed yet

const root = await conn.harness.root();
const { value } = await conn.conversation.watch(root.id);
view = applyImmutable(value, early);

for await (const text of createInterface({ input: process.stdin })) {
  // One id per message. Resending the message with the same id doesn't run the agent twice.
  const requestId = crypto.randomUUID();
  await conn.submit(text, { requestId });
}`,
    },
  ],
};
