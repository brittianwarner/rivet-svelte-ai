import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "bun:test";
import { chat } from "./chat.ts";
import { CHAT_TURNS_PER_HOUR } from "./chat-limits.ts";
import { migratedDatabase, type MemoryDatabase } from "./test-db.ts";
import {
  MISSING_KEY_MESSAGE,
  type ChatMessage,
  type ChatResponseEvent,
} from "@example/wire";

const actions = chat.config.actions!;
type Context = Parameters<typeof actions.sendMessage>[0];
type Event = [name: string, value: unknown];

interface Harness {
  c: Context;
  db: MemoryDatabase;
  events: Event[];
  vars: { turn: Promise<void> | null; turnAbort: AbortController | null };
  /** Wait until the actor's turn loop has nothing left to run. */
  settle: () => Promise<void>;
}

async function harness(
  options: { legacyState?: unknown } = {},
): Promise<Harness> {
  const db = await migratedDatabase(chat, options);
  const events: Event[] = [];
  const vars = { turnAbort: null, turn: null, recheck: false, live: null };
  const c = {
    db,
    vars,
    keepAwake: <T>(promise: Promise<T>) => promise,
    broadcast: (name: string, value: unknown) => events.push([name, value]),
  } as unknown as Context;
  return {
    c,
    db,
    events,
    vars,
    settle: async () => {
      while (vars.turn) await vars.turn;
    },
  };
}

function storedMessages(db: MemoryDatabase): ChatMessage[] {
  return (
    db.sqlite
      .prepare(
        "SELECT id, role, content, created_at AS createdAt FROM messages ORDER BY seq",
      )
      .all() as ChatMessage[]
  ).map((message) => ({ ...message }));
}

/** Answers openrouter.ai in-process with an OpenAI-style SSE stream. */
function fakeProvider(input: { chunks: string[]; gapMs: number }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    resource: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(resource instanceof Request ? resource.url : resource);
    if (url.hostname !== "openrouter.ai") return original(resource, init);
    const signal = init?.signal;
    const encoder = new TextEncoder();
    const line = (delta: object, finish: string | null = null) =>
      encoder.encode(
        `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    const body = new ReadableStream({
      async start(controller) {
        for (const chunk of input.chunks) {
          await Bun.sleep(input.gapMs);
          if (signal?.aborted) {
            controller.error(signal.reason);
            return;
          }
          controller.enqueue(line({ content: chunk }));
        }
        controller.enqueue(line({}, "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const KEYS = ["OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) process.env[key] = "";
});
afterEach(() => {
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test("a turn without a provider settles as an error that is stored in SQLite", async () => {
  const h = await harness();
  assert.deepEqual(await actions.sendMessage(h.c, "  hello  "), {
    accepted: true,
  });
  // The actor, not the request, owns the turn: wait for it to settle.
  await h.settle();
  const stored = storedMessages(h.db);
  assert.deepEqual(
    stored.map(({ role, content }) => [role, content]),
    [
      ["user", "hello"],
      ["assistant", MISSING_KEY_MESSAGE],
    ],
  );
  const snapshot = await actions.getSnapshot(h.c);
  assert.deepEqual(snapshot.messages, stored);
  assert.equal(snapshot.status.state, "error");
  assert.equal(snapshot.status.error, MISSING_KEY_MESSAGE);
  assert.equal(h.vars.turnAbort, null);
  assert.deepEqual(
    h.events.map(([name, value]) =>
      name === "status" ? `status:${(value as { state: string }).state}` : name,
    ),
    [
      "status:queued",
      "messageAdded",
      "messageAdded",
      "status:thinking",
      "response",
      "status:error",
    ],
  );
});

test("sends are validated and one turn runs at a time", async () => {
  const h = await harness();
  for (const text of ["   ", "x".repeat(8001), 42])
    await assert.rejects(actions.sendMessage(h.c, text as string), {
      code: "VALIDATION_FAILED",
    });
  const results = await Promise.allSettled([
    actions.sendMessage(h.c, "one"),
    actions.sendMessage(h.c, "two"),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal((results[1] as PromiseRejectedResult).reason.code, "CHAT_BUSY");
  await h.settle();
  assert.equal(storedMessages(h.db).length, 2);
});

test("each conversation has an hourly turn budget", async () => {
  const h = await harness();
  const now = Date.now();
  const insert = h.db.sqlite.prepare(
    "INSERT INTO turn_budget (admitted_at) VALUES (?)",
  );
  // Expired admissions are pruned and do not count.
  for (let i = 0; i < CHAT_TURNS_PER_HOUR; i++) insert.run(now - 61 * 60_000);
  for (let i = 0; i < CHAT_TURNS_PER_HOUR - 1; i++)
    insert.run(now - 30 * 60_000);
  await actions.sendMessage(h.c, "the last one this hour");
  await h.settle();
  await assert.rejects(actions.sendMessage(h.c, "one too many"), (error) => {
    const refused = error as {
      code: string;
      metadata: { retryAfterMs: number };
    };
    assert.equal(refused.code, "CHAT_TURN_LIMIT");
    assert.ok(refused.metadata.retryAfterMs > 29 * 60_000);
    assert.match(String(error), /Try again in 30 minutes/);
    return true;
  });
  const count = h.db.sqlite
    .prepare("SELECT count(*) AS n FROM turn_budget")
    .get() as { n: number };
  assert.equal(count.n, CHAT_TURNS_PER_HOUR);
  assert.equal((await actions.getStatus(h.c)).state, "error");
});

test("deltas stream from c.vars and reach SQLite at checkpoints and at the end", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const restore = fakeProvider({
    chunks: ["Partial reply", ...Array.from({ length: 14 }, () => " more")],
    gapMs: 100,
  });
  try {
    const h = await harness();
    await actions.sendMessage(h.c, "stream please");
    const responses = () =>
      h.events
        .filter(([name]) => name === "response")
        .map(([, value]) => value as ChatResponseEvent);
    while (responses().length === 0) await Bun.sleep(10);

    // Before the first checkpoint, the snapshot reads the reply from c.vars.
    const assistantId = responses()[0].messageId;
    const early = await actions.getSnapshot(h.c);
    assert.equal(early.status.state, "thinking");
    assert.match(early.messages.at(-1)!.content, /^Partial reply/);
    assert.equal(storedMessages(h.db).at(-1)!.content, "");

    // After about a second, a checkpoint has written partial text.
    while (!storedMessages(h.db).at(-1)!.content) await Bun.sleep(20);
    assert.match(storedMessages(h.db).at(-1)!.content, /^Partial reply/);

    await actions.cancel(h.c);
    await h.settle();
    const final = storedMessages(h.db).at(-1)!;
    assert.equal(final.id, assistantId);
    assert.match(final.content, /^Partial reply/);
    assert.equal((await actions.getStatus(h.c)).state, "idle");
    const done = responses().at(-1)!;
    assert.deepEqual(done, {
      messageId: assistantId,
      delta: "",
      content: final.content,
      done: true,
    });
    // ~100 ms coalescing: fewer broadcasts than chunks would mean per-token.
    const partials = responses().filter((event) => !event.done);
    assert.ok(partials.length >= 2);
    assert.equal(
      partials.map((event) => event.delta).join(""),
      partials.at(-1)!.content,
      "deltas reconstruct the content",
    );
  } finally {
    restore();
  }
});

test("wake runs an admitted turn and marks a cut-off reply as interrupted", async () => {
  const onWake = chat.config.onWake as (c: Context) => Promise<void>;

  const waiting = await harness();
  waiting.db.sqlite.run(
    "UPDATE chat SET status = 'queued', pending = 'still here'",
  );
  await onWake(waiting.c);
  await waiting.settle();
  assert.deepEqual(
    storedMessages(waiting.db).map(({ role, content }) => [role, content]),
    [
      ["user", "still here"],
      ["assistant", MISSING_KEY_MESSAGE],
    ],
  );

  const streaming = await harness();
  streaming.db.sqlite.run("UPDATE chat SET status = 'thinking'");
  await onWake(streaming.c);
  const status = await actions.getStatus(streaming.c);
  assert.equal(status.state, "error");
  assert.match(status.error ?? "", /interrupted/);
  await actions.sendMessage(streaming.c, "continue");
  await streaming.settle();
});

test("the first migration carries a pre-3.0 transcript forward", async () => {
  const onWake = chat.config.onWake as (c: Context) => Promise<void>;
  const messages: ChatMessage[] = [
    { id: "m1", role: "user", content: "hi", createdAt: 1 },
    { id: "m2", role: "assistant", content: "Hello", createdAt: 2 },
  ];
  const h = await harness({
    legacyState: {
      messages,
      status: { state: "thinking", updatedAt: 3 },
      pending: null,
    },
  });
  await onWake(h.c);
  const snapshot = await actions.getSnapshot(h.c);
  assert.deepEqual(snapshot.messages, messages);
  assert.equal(snapshot.status.state, "error");

  const queued = await harness({
    legacyState: {
      messages,
      status: { state: "queued", updatedAt: 3 },
      pending: "  pick this up  ",
    },
  });
  await onWake(queued.c);
  await queued.settle();
  assert.deepEqual(
    storedMessages(queued.db)
      .slice(2)
      .map(({ role, content }) => [role, content]),
    [
      ["user", "pick this up"],
      ["assistant", MISSING_KEY_MESSAGE],
    ],
  );

  for (const legacyState of [
    {
      messages: [{ ...messages[0], role: "system" }],
      status: { state: "idle", updatedAt: 1 },
    },
    {
      messages: [messages[0], messages[0]],
      status: { state: "idle", updatedAt: 1 },
    },
    { messages, status: { state: "sleeping", updatedAt: 1 } },
  ]) {
    const fresh = await harness({ legacyState });
    assert.deepEqual((await actions.getSnapshot(fresh.c)).messages, []);
    assert.equal((await actions.getStatus(fresh.c)).state, "idle");
  }
});
