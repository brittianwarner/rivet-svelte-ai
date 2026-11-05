import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHAT_STATE_BYTES,
  CHAT_STATE_LIMIT,
  type ChatMessage,
} from "@example/wire";
import { trimMessages } from "./actors/chat-limits.ts";
import { portFromEnv } from "./env.ts";

test("history stays bounded in UTF-8 bytes while preserving the newest message", () => {
  for (const content of ["small", "🌍".repeat(4000), "\u0000".repeat(8000)]) {
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      role: i % 2 ? "assistant" : "user",
      content,
      createdAt: i,
    }));
    trimMessages(messages);
    assert.ok(messages.length <= CHAT_STATE_LIMIT);
    assert.ok(Buffer.byteLength(JSON.stringify(messages)) <= CHAT_STATE_BYTES);
    assert.equal(messages.at(-1)?.id, "99");
  }
});

test("invalid ports fail instead of silently falling back", () => {
  assert.equal(portFromEnv(undefined, 6440), 6440);
  assert.equal(portFromEnv("7000", 6440), 7000);
  for (const value of ["oops", "0", "65535", "-1", "1.2"])
    assert.throws(() => portFromEnv(value, 6440));
});
