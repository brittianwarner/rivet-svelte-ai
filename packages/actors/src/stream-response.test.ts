import assert from "node:assert/strict";
import { test } from "bun:test";
import { consumeResponse } from "./stream-response.ts";

async function* chunks(...values: string[]) {
  yield* values;
}

test("coalesced deltas reconstruct content and the final chunk is checkpointed", async () => {
  const updates: [string, string][] = [];
  const result = await consumeResponse(chunks("a", "b", "c"), {
    maxLength: 8000,
    signal: new AbortController().signal,
    now: () => 0,
    publish: (content, delta) => updates.push([content, delta]),
  });
  assert.deepEqual(updates, [
    ["a", "a"],
    ["abc", "bc"],
  ]);
  assert.deepEqual(result, { content: "abc", limited: false });
});

test("response length stops consumption and closes the source", async () => {
  let closed = false;
  async function* source() {
    try {
      yield "123456789";
      assert.fail("Read beyond output limit");
    } finally {
      closed = true;
    }
  }
  const result = await consumeResponse(source(), {
    maxLength: 4,
    signal: new AbortController().signal,
    publish() {},
  });
  assert.deepEqual(result, { content: "1234", limited: true });
  assert.ok(closed);
});

test("cancellation and provider failure preserve the last partial content", async () => {
  const abort = new AbortController();
  let checkpoint = "";
  async function* cancelled() {
    yield "hello";
    abort.abort();
    yield "ignored";
  }
  assert.equal(
    (
      await consumeResponse(cancelled(), {
        maxLength: 8000,
        signal: abort.signal,
        publish: (content) => {
          checkpoint = content;
        },
      })
    ).content,
    "hello",
  );
  async function* failed() {
    yield "a";
    yield "b";
    throw new Error("provider failed");
  }
  await assert.rejects(
    consumeResponse(failed(), {
      maxLength: 8000,
      signal: new AbortController().signal,
      now: () => 0,
      publish: (content) => {
        checkpoint = content;
      },
    }),
    /provider failed/,
  );
  assert.equal(checkpoint, "ab");
});

test("checkpoints run at most once per interval while streaming", async () => {
  let clock = 0;
  const saved: string[] = [];
  async function* ticking() {
    for (const chunk of ["a", "b", "c", "d", "e"]) {
      clock += 400;
      yield chunk;
    }
  }
  const result = await consumeResponse(ticking(), {
    maxLength: 8000,
    signal: new AbortController().signal,
    now: () => clock,
    publish() {},
    checkpoint: async (content) => {
      saved.push(content);
    },
  });
  // Due at 1200 ("abc"); 2000 is only 800 ms later, so the caller's own
  // final write covers "abcde".
  assert.deepEqual(saved, ["abc"]);
  assert.equal(result.content, "abcde");
});
