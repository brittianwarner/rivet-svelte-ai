import { streamText, type ModelMessage } from "ai";
import { actor, event, queue, UserError } from "rivetkit";
import {
  CHAT_PROMPT_LIMIT,
  MAX_CHAT_RESPONSE_LENGTH,
  MAX_CHAT_MESSAGE_LENGTH,
  MISSING_KEY_MESSAGE,
  type ChatMessage,
  type ChatQueueMessage,
  type ChatResponseEvent,
  type ChatStatusSnapshot,
} from "@example/wire";
import { authorizeConnection } from "../auth.ts";
import { consumeResponse } from "./stream-response.ts";
import { trimMessages } from "./chat-limits.ts";
import { createLanguageModel } from "../model.ts";

const SYSTEM_PROMPT = "You are a concise assistant. Answer in plain sentences.";

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

function promptMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.slice(-CHAT_PROMPT_LIMIT).map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

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
    message: queue<ChatQueueMessage>({ canPublish: () => false }),
  },
  events: {
    messageAdded: event<ChatMessage>(),
    response: event<ChatResponseEvent>(),
    status: event<ChatStatusSnapshot>(),
  },
  onBeforeConnect: (c, params) => {
    authorizeConnection(c, params);
  },
  onWake: (c) => {
    if (c.state.status.state === "thinking") {
      c.state.status = {
        state: "error",
        updatedAt: Date.now(),
        error:
          "The previous reply was interrupted. Send a new message to continue.",
      };
    }
    trimMessages(c.state.messages);
  },
  onSleep: (c) => {
    c.vars.turnAbort?.abort();
  },
  run: async (c) => {
    for await (const queued of c.queue.iter()) {
      if (c.aborted) return;

      // Validate persisted queue payloads too, including entries from older versions.
      const text =
        typeof queued.body?.text === "string" ? queued.body.text.trim() : "";
      if (!text || text.length > MAX_CHAT_MESSAGE_LENGTH) continue;

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

          const assistantMessage: ChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            createdAt: Date.now(),
          };
          c.state.messages.push(assistantMessage);
          trimMessages(c.state.messages);
          // Mutate the tracked state proxy so each streamed checkpoint schedules a save.
          const assistant = c.state.messages[c.state.messages.length - 1]!;
          c.broadcast("messageAdded", assistant);

          const setStatus = (next: ChatStatusSnapshot) => {
            c.state.status = next;
            c.broadcast("status", next);
          };

          const finish = (input: {
            state: "idle" | "error";
            error?: string;
          }) => {
            trimMessages(c.state.messages);
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

          const deadline = AbortSignal.timeout(120_000);
          try {
            const selected = createLanguageModel();
            if (!selected.model) {
              assistant.content = MISSING_KEY_MESSAGE;
              finish({ state: "error", error: MISSING_KEY_MESSAGE });
              return;
            }

            let providerError: unknown;
            const result = streamText({
              model: selected.model,
              instructions: SYSTEM_PROMPT,
              messages: prompt,
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
                assistant.content = content;
                trimMessages(c.state.messages);
                c.broadcast("response", {
                  messageId: assistant.id,
                  delta,
                  content,
                  done: false,
                });
              },
            });
            if (providerError !== undefined) throw providerError;
            if (response.limited) abort.abort();
            if (deadline.aborted) {
              finish({
                state: "error",
                error: "The model request timed out. Try a shorter message.",
              });
              return;
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
            if (deadline.aborted && !abort.signal.aborted && !c.aborted) {
              finish({
                state: "error",
                error: "The model request timed out. Try a shorter message.",
              });
              return;
            }
            if (
              abort.signal.aborted ||
              c.aborted ||
              errorName(error) === "AbortError"
            ) {
              finish({ state: "idle" });
              return;
            }

            // SDK errors can contain prompts, headers, and provider response bodies.
            console.error("Chat generation failed", {
              name: errorName(error) ?? "Error",
            });
            const message =
              "The model request failed. Check the API logs and provider configuration.";
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
    getSnapshot: (c) => ({
      messages: c.state.messages,
      status: c.state.status,
    }),
    getHistory: (c) => c.state.messages,
    getStatus: (c) => c.state.status,
    /**
     * Browser entry. The action only accepts the text and queues it.
     * The run loop owns the model call, so this returns before the reply finishes.
     */
    sendMessage: async (c, text: string) => {
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
      if (
        c.state.status.state === "thinking" ||
        c.state.status.state === "queued"
      ) {
        throw new UserError("Wait for the current reply to finish.", {
          code: "CHAT_BUSY",
        });
      }
      c.state.status = { state: "queued", updatedAt: Date.now() };
      c.broadcast("status", c.state.status);
      try {
        await c.queue.send("message", { text: trimmed });
      } catch (error) {
        c.state.status = {
          state: "error",
          updatedAt: Date.now(),
          error: "Could not queue the message.",
        };
        c.broadcast("status", c.state.status);
        throw error;
      }
      return { accepted: true as const };
    },
    cancel: (c) => {
      c.vars.turnAbort?.abort();
      return { ok: true as const };
    },
  },
});
