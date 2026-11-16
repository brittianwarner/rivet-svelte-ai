import {
  CHAT_STATE_LIMIT,
  CHAT_STATE_BYTES,
  type ChatMessage,
} from "@example/wire";

/**
 * Model turns one conversation may start in a rolling hour. Every turn spends
 * provider budget, and the actor is reachable by anyone who can open it, so
 * each conversation carries its own ceiling.
 */
export const CHAT_TURNS_PER_HOUR = 30;
export const CHAT_TURN_WINDOW_MS = 60 * 60 * 1000;

const encoder = new TextEncoder();

/** Bound serialized size as well as row count, including escaped/unicode text. */
export function trimMessages(messages: ChatMessage[]): void {
  while (
    messages.length > 1 &&
    (messages.length > CHAT_STATE_LIMIT ||
      encoder.encode(JSON.stringify(messages)).byteLength > CHAT_STATE_BYTES)
  ) {
    messages.shift();
  }
}
