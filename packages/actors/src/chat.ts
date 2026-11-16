import { streamText, type ModelMessage } from "ai";
import { actor, event, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import {
  migrations,
  type MigrationDatabase,
} from "rivetkit/unstable/migrations";
import {
  CHAT_PROMPT_LIMIT,
  MAX_CHAT_RESPONSE_LENGTH,
  MAX_CHAT_MESSAGE_LENGTH,
  MISSING_KEY_MESSAGE,
  type ChatMessage,
  type ChatResponseEvent,
  type ChatStatusSnapshot,
} from "@example/wire";
import { authorizeConnection } from "./auth.ts";
import { consumeResponse } from "./stream-response.ts";
import {
  CHAT_TURN_WINDOW_MS,
  CHAT_TURNS_PER_HOUR,
  trimMessages,
} from "./chat-limits.ts";
import { isCount, isRecord, readLegacyState } from "./legacy-state.ts";
import { createLanguageModel } from "./model.ts";

const SYSTEM_PROMPT = "You are a concise assistant. Answer in plain sentences.";
const INTERRUPTED =
  "The previous reply was interrupted. Send a new message to continue.";
const STATUSES: readonly ChatStatusSnapshot["state"][] = [
  "idle",
  "queued",
  "thinking",
  "error",
];

type Database = Pick<RawAccess, "execute">;

interface ChatSnapshot {
  messages: ChatMessage[];
  status: ChatStatusSnapshot;
}

function errorName(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
  ) {
    return error.name;
  }
  return null;
}

function promptMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.slice(-CHAT_PROMPT_LIMIT).map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

async function readMessages(db: Database): Promise<ChatMessage[]> {
  const rows = await db.execute<{
    id: string;
    role: ChatMessage["role"];
    content: string;
    created_at: number;
  }>("SELECT id, role, content, created_at FROM messages ORDER BY seq");
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

async function readStatus(db: Database): Promise<ChatStatusSnapshot> {
  const [row] = await db.execute<{
    status: ChatStatusSnapshot["state"];
    error: string | null;
    updated_at: number;
  }>("SELECT status, error, updated_at FROM chat WHERE id = 1");
  return {
    state: row.status,
    updatedAt: row.updated_at,
    ...(row.error !== null ? { error: row.error } : {}),
  };
}

async function writeStatus(
  tx: Database,
  status: ChatStatusSnapshot,
): Promise<void> {
  await tx.execute(
    "UPDATE chat SET status = ?, error = ?, updated_at = ? WHERE id = 1",
    status.state,
    status.error ?? null,
    status.updatedAt,
  );
}

async function insertMessage(
  tx: Database,
  message: ChatMessage,
): Promise<void> {
  await tx.execute(
    "INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)",
    message.id,
    message.role,
    message.content,
    message.createdAt,
  );
}

/**
 * Drop the oldest rows until the transcript fits its row and byte bounds.
 * Runs inside every transaction that grows the transcript.
 */
async function pruneTranscript(tx: Database): Promise<void> {
  const messages = await readMessages(tx);
  const kept = messages.slice();
  trimMessages(kept);
  const dropped = messages.length - kept.length;
  if (dropped > 0) {
    await tx.execute(
      "DELETE FROM messages WHERE seq IN (SELECT seq FROM messages ORDER BY seq LIMIT ?)",
      dropped,
    );
  }
}

/** Write the reply's text so far and keep the transcript within bounds. */
async function saveReply(tx: Database, reply: LiveReply): Promise<void> {
  await tx.execute(
    "UPDATE messages SET content = ? WHERE id = ?",
    reply.content,
    reply.id,
  );
  await pruneTranscript(tx);
}

/**
 * Count this turn against the conversation's hourly budget, or refuse it.
 * Runs in the admitting transaction, so concurrent sends cannot overspend.
 */
async function spendTurn(tx: Database, now: number): Promise<void> {
  await tx.execute(
    "DELETE FROM turn_budget WHERE admitted_at <= ?",
    now - CHAT_TURN_WINDOW_MS,
  );
  const [row] = await tx.execute<{ used: number; oldest: number | null }>(
    "SELECT count(*) AS used, min(admitted_at) AS oldest FROM turn_budget",
  );
  if (row.used >= CHAT_TURNS_PER_HOUR) {
    const retryAfterMs = (row.oldest ?? now) + CHAT_TURN_WINDOW_MS - now;
    const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
    throw new UserError(
      `This conversation has used its ${CHAT_TURNS_PER_HOUR} replies for this hour. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
      { code: "CHAT_TURN_LIMIT", metadata: { retryAfterMs } },
    );
  }
  await tx.execute("INSERT INTO turn_budget (admitted_at) VALUES (?)", now);
}

/** The reply being streamed. Ahead of its last SQLite checkpoint. */
interface LiveReply {
  id: string;
  content: string;
}

/** In-memory only: rebuilt empty on every wake. */
interface ChatVars {
  /** Stops the running turn: cancel, deadline, or actor sleep. */
  turnAbort: AbortController | null;
  /** The loop running admitted turns, if any. */
  turn: Promise<void> | null;
  /** Set when an admitted turn may not have been picked up yet. */
  recheck: boolean;
  live: LiveReply | null;
}

/**
 * What a turn needs from the actor. Actions and `onWake` both satisfy it.
 * Deliberately no `aborted`: on an action context that tracks the HTTP
 * request, which ends long before the turn. Actor shutdown reaches the turn
 * through `onSleep` → `turnAbort` instead.
 */
interface TurnHost {
  db: RawAccess;
  vars: ChatVars;
  keepAwake<T>(promise: Promise<T>): Promise<T>;
  broadcast(name: "messageAdded", message: ChatMessage): void;
  broadcast(name: "response", event: ChatResponseEvent): void;
  broadcast(name: "status", status: ChatStatusSnapshot): void;
}

/**
 * The transcript and status from one transaction, with the streaming reply's
 * newest text from `c.vars` laid over its checkpoint.
 */
async function readSnapshot(c: {
  db: RawAccess;
  vars: ChatVars;
}): Promise<ChatSnapshot> {
  const snapshot = await c.db.transaction(
    async (tx) => ({
      messages: await readMessages(tx),
      status: await readStatus(tx),
    }),
    { name: "chat-snapshot" },
  );
  const live = c.vars.live;
  if (!live) return snapshot;
  const messages = snapshot.messages.map((message) =>
    message.id === live.id ? { ...message, content: live.content } : message,
  );
  trimMessages(messages);
  return { messages, status: snapshot.status };
}

/**
 * Run admitted turns if no loop is running. One turn at a time per
 * conversation; `keepAwake` holds the actor until the model call settles, so
 * a closed browser socket never cancels a reply.
 */
function drain(c: TurnHost): void {
  c.vars.recheck = true;
  if (c.vars.turn) return;
  c.vars.turn = c
    .keepAwake(runAdmittedTurns(c))
    .catch((error: unknown) => {
      console.error("Chat turn failed", { name: errorName(error) ?? "Error" });
    })
    .finally(() => {
      c.vars.turn = null;
      // A send can land between the loop's last check and this callback.
      if (c.vars.recheck) drain(c);
    });
}

async function runAdmittedTurns(c: TurnHost): Promise<void> {
  while (c.vars.recheck) {
    c.vars.recheck = false;
    const turn = await startTurn(c);
    if (turn) await runTurn(c, turn);
  }
}

interface Turn {
  assistant: ChatMessage;
  prompt: ModelMessage[];
}

/**
 * Take the pending text and record the turn in one transaction: the user
 * message, an empty assistant message, and `thinking`. From here the
 * transcript, not `pending`, records the turn.
 */
async function startTurn(c: TurnHost): Promise<Turn | null> {
  const now = Date.now();
  const started = await c.db.transaction(
    async (tx) => {
      const [row] = await tx.execute<{ pending: string | null }>(
        "SELECT pending FROM chat WHERE id = 1",
      );
      if (row.pending === null) return null;
      const user: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: row.pending,
        createdAt: now,
      };
      await insertMessage(tx, user);
      const prompt = promptMessages(await readMessages(tx));
      const assistant: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        createdAt: now,
      };
      await insertMessage(tx, assistant);
      await pruneTranscript(tx);
      const status: ChatStatusSnapshot = { state: "thinking", updatedAt: now };
      await tx.execute("UPDATE chat SET pending = NULL WHERE id = 1");
      await writeStatus(tx, status);
      return { user, assistant, prompt, status };
    },
    { name: "chat-start-turn" },
  );
  if (!started) return null;
  c.broadcast("messageAdded", started.user);
  c.broadcast("messageAdded", started.assistant);
  c.broadcast("status", started.status);
  return { assistant: started.assistant, prompt: started.prompt };
}

/**
 * Stream one reply. Deltas live in `c.vars.live` and are broadcast about
 * every 100 ms; SQLite gets a checkpoint about every second and the final
 * text when the turn settles.
 */
async function runTurn(c: TurnHost, turn: Turn): Promise<void> {
  const abort = new AbortController();
  c.vars.turnAbort = abort;
  const live: LiveReply = { id: turn.assistant.id, content: "" };
  c.vars.live = live;

  const finish = async (input: {
    state: "idle" | "error";
    error?: string;
  }): Promise<void> => {
    const status: ChatStatusSnapshot = {
      state: input.state,
      updatedAt: Date.now(),
      ...(input.error ? { error: input.error } : {}),
    };
    await c.db.transaction(
      async (tx) => {
        await saveReply(tx, live);
        await writeStatus(tx, status);
      },
      { name: "chat-finish-turn" },
    );
    c.broadcast("response", {
      messageId: live.id,
      delta: "",
      content: live.content,
      done: true,
      ...(input.error ? { error: input.error } : {}),
    });
    c.broadcast("status", status);
  };

  const deadline = AbortSignal.timeout(120_000);
  try {
    const selected = createLanguageModel();
    // The registry hosts chat only with a provider, but a host that composes
    // `actors` itself may not have one: answer instead of calling nothing.
    if (!selected.model) {
      live.content = MISSING_KEY_MESSAGE;
      await finish({ state: "error", error: MISSING_KEY_MESSAGE });
      return;
    }

    let providerError: unknown;
    const result = streamText({
      model: selected.model,
      instructions: SYSTEM_PROMPT,
      messages: turn.prompt,
      abortSignal: AbortSignal.any([abort.signal, deadline]),
      maxOutputTokens: 2_000,
      onError: ({ error }) => {
        providerError = error;
      },
    });

    const response = await consumeResponse(result.textStream, {
      maxLength: MAX_CHAT_RESPONSE_LENGTH,
      signal: abort.signal,
      publish: (content, delta) => {
        live.content = content;
        c.broadcast("response", {
          messageId: live.id,
          delta,
          content,
          done: false,
        });
      },
      checkpoint: (content) =>
        c.db.transaction((tx) => saveReply(tx, { id: live.id, content }), {
          name: "chat-checkpoint",
        }),
    });
    if (providerError !== undefined) throw providerError;
    if (response.limited) abort.abort();
    if (deadline.aborted) {
      await finish({
        state: "error",
        error: "The model request timed out. Try a shorter message.",
      });
      return;
    }
    const stopped = abort.signal.aborted;
    if (!live.content && !stopped) {
      live.content = "The model returned an empty response.";
      await finish({ state: "error", error: live.content });
      return;
    }

    await finish({ state: "idle" });
  } catch (error) {
    if (deadline.aborted && !abort.signal.aborted) {
      await finish({
        state: "error",
        error: "The model request timed out. Try a shorter message.",
      });
      return;
    }
    if (abort.signal.aborted || errorName(error) === "AbortError") {
      await finish({ state: "idle" });
      return;
    }

    // SDK errors can contain prompts, headers, and provider response bodies.
    console.error("Chat generation failed", {
      name: errorName(error) ?? "Error",
    });
    const message =
      "The model request failed. Check the API logs and provider configuration.";
    if (!live.content) live.content = message;
    await finish({ state: "error", error: message });
  } finally {
    if (c.vars.turnAbort === abort) c.vars.turnAbort = null;
    if (c.vars.live === live) c.vars.live = null;
  }
}

interface LegacyChat {
  messages: ChatMessage[];
  status: ChatStatusSnapshot;
  pending: string | null;
}

function isAdmissible(text: unknown): text is string {
  return (
    typeof text === "string" &&
    text.trim().length > 0 &&
    text.length <= MAX_CHAT_MESSAGE_LENGTH
  );
}

/** The pre-3.0 state, or null unless it has the shape this actor wrote. */
function legacyChat(state: unknown): LegacyChat | null {
  if (
    !isRecord(state) ||
    !Array.isArray(state.messages) ||
    !isRecord(state.status)
  ) {
    return null;
  }
  const messages: ChatMessage[] = [];
  for (const message of state.messages) {
    if (
      !isRecord(message) ||
      typeof message.id !== "string" ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string" ||
      !isCount(message.createdAt) ||
      messages.some((seen) => seen.id === message.id)
    ) {
      return null;
    }
    messages.push({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    });
  }
  const { state: phase, updatedAt, error } = state.status;
  if (
    !STATUSES.includes(phase as ChatStatusSnapshot["state"]) ||
    !isCount(updatedAt) ||
    (error !== undefined && typeof error !== "string")
  ) {
    return null;
  }
  trimMessages(messages);
  // Older versions had no `pending`; invalid text is dropped, not run.
  const pending = isAdmissible(state.pending) ? state.pending.trim() : null;
  return {
    messages,
    pending,
    // Queued with nothing to run would refuse every send as busy.
    status:
      phase === "queued" && pending === null
        ? { state: "idle", updatedAt }
        : {
            state: phase as ChatStatusSnapshot["state"],
            updatedAt,
            ...(error !== undefined ? { error } : {}),
          },
  };
}

async function createSchema(db: MigrationDatabase): Promise<void> {
  await db.execute(`
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE chat (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      error TEXT,
      updated_at INTEGER NOT NULL,
      pending TEXT
    );
    CREATE TABLE turn_budget (admitted_at INTEGER NOT NULL);
  `);
  const legacy = legacyChat(await readLegacyState(db));
  const status = legacy?.status ?? { state: "idle", updatedAt: Date.now() };
  await db.execute(
    "INSERT INTO chat (id, status, error, updated_at, pending) VALUES (1, ?, ?, ?, ?)",
    status.state,
    status.error ?? null,
    status.updatedAt,
    legacy?.pending ?? null,
  );
  for (const message of legacy?.messages ?? [])
    await insertMessage(db, message);
}

/**
 * One actor per conversation. Key: ["chat", chatId].
 *
 * Durable data lives in SQLite: the bounded transcript, the status, the
 * admitted text whose turn has not started (`chat.pending`) and the hourly
 * turn budget. The reply being streamed, the abort controller and the turn
 * loop live in `c.vars`.
 *
 * `sendMessage` validates, records the text as pending, starts the turn and
 * returns at once. If the actor stops between accepting and starting,
 * `onWake` runs the pending text; a turn cut off mid-reply is marked
 * interrupted instead of silently re-billed.
 */
export const chat = actor({
  db: db({
    onMigrate: migrations({
      migrations: [{ version: 1, up: createSchema }],
    }),
  }),
  createVars: (): ChatVars => ({
    turnAbort: null,
    turn: null,
    recheck: false,
    live: null,
  }),
  events: {
    messageAdded: event<ChatMessage>(),
    response: event<ChatResponseEvent>(),
    status: event<ChatStatusSnapshot>(),
  },
  onBeforeConnect: (c, params) => {
    authorizeConnection(c, params);
  },
  onWake: async (c) => {
    // Nothing streams across a stop; an unfinished reply becomes an error.
    await c.db.execute(
      "UPDATE chat SET status = 'error', error = ?, updated_at = ? WHERE id = 1 AND status = 'thinking'",
      INTERRUPTED,
      Date.now(),
    );
    drain(c);
  },
  onSleep: (c) => {
    c.vars.turnAbort?.abort();
  },
  actions: {
    getSnapshot: (c): Promise<ChatSnapshot> => readSnapshot(c),
    getHistory: async (c): Promise<ChatMessage[]> =>
      (await readSnapshot(c)).messages,
    getStatus: (c): Promise<ChatStatusSnapshot> => readStatus(c.db),
    /**
     * Browser entry. Admits the text and starts the turn in the background,
     * so this returns before the reply finishes.
     */
    sendMessage: async (c, text: string): Promise<{ accepted: true }> => {
      if (typeof text !== "string") {
        throw new UserError("Message must be text.", {
          code: "VALIDATION_FAILED",
        });
      }
      const trimmed = text.trim();
      if (!trimmed) {
        throw new UserError("Enter a message.", { code: "VALIDATION_FAILED" });
      }
      if (trimmed.length > MAX_CHAT_MESSAGE_LENGTH) {
        throw new UserError("That message is too long.", {
          code: "VALIDATION_FAILED",
        });
      }
      const now = Date.now();
      const queued = await c.db.transaction(
        async (tx) => {
          const current = await readStatus(tx);
          if (current.state === "thinking" || current.state === "queued") {
            throw new UserError("Wait for the current reply to finish.", {
              code: "CHAT_BUSY",
            });
          }
          await spendTurn(tx, now);
          const status: ChatStatusSnapshot = {
            state: "queued",
            updatedAt: now,
          };
          await tx.execute("UPDATE chat SET pending = ? WHERE id = 1", trimmed);
          await writeStatus(tx, status);
          return status;
        },
        { name: "chat-admit-turn" },
      );
      c.broadcast("status", queued);
      drain(c);
      return { accepted: true as const };
    },
    cancel: (c) => {
      c.vars.turnAbort?.abort();
      return { ok: true as const };
    },
  },
});
