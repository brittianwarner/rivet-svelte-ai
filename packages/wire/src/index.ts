/** One row in a conversation transcript. The chat actor is the source of truth. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

/** Live status of the conversation actor. */
export interface ChatStatusSnapshot {
  state: "idle" | "queued" | "thinking" | "error";
  updatedAt: number;
  error?: string;
}

/**
 * One streaming update. `content` is the full assistant text so far,
 * so a missed delta still converges.
 */
export interface ChatResponseEvent {
  messageId: string;
  delta: string;
  content: string;
  done: boolean;
  error?: string;
}

/** Payload pushed onto the chat actor's `message` queue. */
export interface ChatQueueMessage {
  text: string;
}

/** What the browser needs to open an actor socket. Never includes a model key. */
export interface ClientConfig {
  rivetEndpoint: string;
  actorToken: string | null;
}

/** Which model the API will call. `none` means neither key is set. */
export interface ProviderStatus {
  provider: "openrouter" | "gemini" | "none";
  model: string | null;
}

export const CHAT_STATE_LIMIT = 40;
export const CHAT_STATE_BYTES = 64 * 1024;
export const MAX_CHAT_RESPONSE_LENGTH = 8_000;
export const CHAT_PROMPT_LIMIT = 20;
export const MAX_CHAT_MESSAGE_LENGTH = 8_000;

/** Counter names used in the actor key and the Hono route. */
export const COUNTER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const MISSING_KEY_MESSAGE =
  "Set OPENROUTER_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY on the API, then send again.";

export const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.8-flash";
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
