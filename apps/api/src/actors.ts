import { streamText, type ModelMessage } from "ai";
import { actor, event, queue, setup, UserError } from "rivetkit";
import {
  CHAT_PROMPT_LIMIT,
  CHAT_STATE_LIMIT,
  MAX_CHAT_MESSAGE_LENGTH,
  MISSING_KEY_MESSAGE,
  type ChatMessage,
  type ChatQueueMessage,
  type ChatResponseEvent,
  type ChatStatusSnapshot,
} from "@example/wire";
import { authorizeConnection } from "./auth.ts";
import { enginePort, loadRootEnv } from "./env.ts";
import { createLanguageModel } from "./model.ts";

loadRootEnv();

const SYSTEM_PROMPT =
  "You are a concise assistant. Answer in plain sentences.";

const RIVET_CONTROL_FLOW = new Set([
  "SleepError",
  "MessageWaitError",
  "EvictedError",
  "CancelledError",
  "EntryInProgressError",
  "RaceError",
  "JoinError",
  "HistoryDivergedError",
  "RollbackError",
]);

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

/** Rivet uses thrown control-flow errors to drive the run loop. Let them propagate. */
function rethrowIfRivetControlFlow(error: unknown): void {
  const name = errorName(error);
  if (name && RIVET_CONTROL_FLOW.has(name)) {
    throw error;
  }
}

function trimMessages(messages: ChatMessage[]): void {
  while (messages.length > CHAT_STATE_LIMIT) {
    messages.shift();
  }
}

function promptMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.slice(-CHAT_PROMPT_LIMIT).map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

/**
 * Quickstart counter. The browser socket and the Hono route both call it.
 * Key: ["counter", name]
 */
export const counter = actor({
  state: { count: 0 },
  onBeforeConnect: (c, params) => {
    authorizeConnection(c, params);
  },
  actions: {
    getCount: (c) => c.state.count,
    increment: (c, by: number) => {
      if (!Number.isInteger(by) || by < 1 || by > 100) {
        throw new UserError("Increment must be a whole number from 1 to 100.", {
          code: "VALIDATION_FAILED",
        });
      }
      c.state.count += by;
      c.broadcast("newCount", c.state.count);
      return c.state.count;
    },
  },
});

/**
 * One actor per conversation. Key: ["chat", chatId].
 *
 * The browser calls `sendMessage`. That action only queues the text.
 * This run loop calls the model, so a closed socket does not cancel the turn.
 * `keepAwake` holds the actor until the turn finishes. The transcript stays
 * in actor state for the next `getHistory`.
 */
export const chat = actor({
  state: {
    messages: [] as ChatMessage[],
    status: {
      state: "idle",
      updatedAt: Date.now(),
    } as ChatStatusSnapshot,
  },
  createVars: () => ({
    turnAbort: null as AbortController | null,
  }),
  queues: {
    message: queue<ChatQueueMessage>(),
  },
  events: {
    messageAdded: event<ChatMessage>(),
    response: event<ChatResponseEvent>(),
    status: event<ChatStatusSnapshot>(),
  },
  onBeforeConnect: (c, params) => {
    authorizeConnection(c, params);
  },
  run: async (c) => {
    for await (const queued of c.queue.iter()) {
      if (c.aborted) return;

      const text = queued.body?.text?.trim() ?? "";
      if (!text) continue;

      await c.keepAwake(
        (async () => {
          const abort = new AbortController();
          c.vars.turnAbort = abort;

          const userMessage: ChatMessage = {
            id: crypto.randomUUID(),
            role: "user",
            content: text,
            createdAt: Date.now(),
          };
          c.state.messages.push(userMessage);
          c.broadcast("messageAdded", userMessage);

          const prompt = promptMessages(c.state.messages);

          const assistant: ChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            createdAt: Date.now(),
          };
          c.state.messages.push(assistant);
          trimMessages(c.state.messages);
          c.broadcast("messageAdded", assistant);

          const setStatus = (next: ChatStatusSnapshot) => {
            c.state.status = next;
            c.broadcast("status", next);
          };

          const finish = (input: {
            state: "idle" | "error";
            error?: string;
          }) => {
            c.broadcast("response", {
              messageId: assistant.id,
              delta: "",
              content: assistant.content,
              done: true,
              ...(input.error ? { error: input.error } : {}),
            });
            setStatus({
              state: input.state,
              updatedAt: Date.now(),
              ...(input.error ? { error: input.error } : {}),
            });
          };

          setStatus({ state: "thinking", updatedAt: Date.now() });

          try {
            const selected = createLanguageModel();
            if (!selected.model) {
              assistant.content = MISSING_KEY_MESSAGE;
              finish({ state: "error", error: MISSING_KEY_MESSAGE });
              return;
            }

            const result = streamText({
              model: selected.model,
              instructions: SYSTEM_PROMPT,
              messages: prompt,
              abortSignal: abort.signal,
            });

            let content = "";
            for await (const delta of result.textStream) {
              if (c.aborted || abort.signal.aborted) break;
              content += delta;
              assistant.content = content;
              c.broadcast("response", {
                messageId: assistant.id,
                delta,
                content,
                done: false,
              });
            }

            const stopped = abort.signal.aborted || c.aborted;
            if (!assistant.content && !stopped) {
              assistant.content = "The model returned an empty response.";
              finish({ state: "error", error: assistant.content });
              return;
            }

            finish({ state: "idle" });
          } catch (error) {
            rethrowIfRivetControlFlow(error);
            if (abort.signal.aborted || c.aborted || errorName(error) === "AbortError") {
              finish({ state: "idle" });
              return;
            }

            const message =
              error instanceof Error ? error.message : "The model request failed.";
            if (!assistant.content) assistant.content = message;
            finish({ state: "error", error: message });
          } finally {
            if (c.vars.turnAbort === abort) c.vars.turnAbort = null;
          }
        })(),
      );
    }
  },
  actions: {
    getHistory: (c) => c.state.messages,
    getStatus: (c) => c.state.status,
    /**
     * Browser entry. The action only accepts the text and queues it.
     * The run loop owns the model call, so this returns before the reply finishes.
     */
    sendMessage: async (c, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        throw new UserError("Enter a message.", { code: "VALIDATION_FAILED" });
      }
      if (trimmed.length > MAX_CHAT_MESSAGE_LENGTH) {
        throw new UserError("That message is too long.", { code: "VALIDATION_FAILED" });
      }
      await c.queue.send("message", { text: trimmed });
      return { accepted: true as const };
    },
    cancel: (c) => {
      c.vars.turnAbort?.abort();
      return { ok: true as const };
    },
  },
});

const cloudEndpoint = process.env.RIVET_ENDPOINT?.trim();
const localEnginePort = enginePort();

export const registry = setup({
  use: { counter, chat },
  ...(cloudEndpoint
    ? {}
    : {
        startEngine: true,
        enginePort: localEnginePort,
        httpPort: localEnginePort + 1,
      }),
});
