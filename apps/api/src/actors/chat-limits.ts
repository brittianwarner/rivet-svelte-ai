import {
  CHAT_STATE_LIMIT,
  CHAT_STATE_BYTES,
  type ChatMessage,
} from "@example/wire";

const encoder = new TextEncoder();

/** Bound serialized state as well as row count, including escaped/unicode text. */
export function trimMessages(messages: ChatMessage[]): void {
  while (
    messages.length > 1 &&
    (messages.length > CHAT_STATE_LIMIT ||
      encoder.encode(JSON.stringify(messages)).byteLength > CHAT_STATE_BYTES)
  ) {
    messages.shift();
  }
}
