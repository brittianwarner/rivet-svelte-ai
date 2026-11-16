import assert from "node:assert/strict";
import { test } from "bun:test";
import { createRegistry } from "./registry.ts";

const base = {
  endpoint: "http://127.0.0.1:1",
  namespace: "default",
  pool: "default",
  version: 1,
};

test("chat is hosted only when the caller says a provider is configured", () => {
  const hosted = (chat: boolean) =>
    Object.keys(
      (
        createRegistry({ ...base, chat }) as unknown as {
          config: { use: object };
        }
      ).config.use,
    );
  assert.ok(hosted(true).includes("chat"));
  assert.ok(!hosted(false).includes("chat"));
  assert.deepEqual(
    hosted(false).toSorted(),
    hosted(true)
      .filter((name) => name !== "chat")
      .toSorted(),
  );
});
