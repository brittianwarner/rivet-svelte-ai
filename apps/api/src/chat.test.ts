import assert from "node:assert/strict";
import { test } from "node:test";
import { chat } from "./actors/chat.ts";
import { MISSING_KEY_MESSAGE } from "@example/wire";

/** Model the runtime boundary: only changes through a state proxy schedule saves. */
function tracked<T extends object>(target: T, writes: string[]): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      return value !== null && typeof value === "object"
        ? tracked(value, writes)
        : value;
    },
    set(object, property, value) {
      writes.push(String(property));
      return Reflect.set(object, property, value);
    },
  });
}

test("chat writes assistant content through tracked state and settles a missing provider", async () => {
  const previous = {
    openrouter: process.env.OPENROUTER_API_KEY,
    google: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  };
  process.env.OPENROUTER_API_KEY = "";
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "";
  try {
    const writes: string[] = [];
    const state = tracked(
      { messages: [], status: { state: "queued", updatedAt: Date.now() } },
      writes,
    );
    const context = {
      state,
      vars: { turnAbort: null },
      aborted: false,
      queue: {
        async *iter() {
          yield { body: { text: "hello" } };
        },
      },
      keepAwake: <T>(promise: Promise<T>) => promise,
      broadcast() {},
    };
    const run = chat.config.run!;
    assert.ok(typeof run === "function");
    await run(context as unknown as Parameters<typeof run>[0]);
    assert.ok(
      writes.includes("content"),
      "assistant updates must schedule state writes",
    );
    assert.equal(state.status.state, "error");
    assert.equal(
      (state.messages[1] as { content: string }).content,
      MISSING_KEY_MESSAGE,
    );
    assert.equal(context.vars.turnAbort, null);
  } finally {
    for (const [key, value] of [
      ["OPENROUTER_API_KEY", previous.openrouter],
      ["GOOGLE_GENERATIVE_AI_API_KEY", previous.google],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
