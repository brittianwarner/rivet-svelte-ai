import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.ts";

const calls: Array<[string, number]> = [];
const app = createApp({
  origins: ["http://localhost:5173"],
  endpoint: () => "http://localhost:6440",
  token: () => null,
  provider: () => ({ provider: "none", modelId: null }),
  increment: async (name, by) => {
    calls.push([name, by]);
    return by;
  },
});
const post = (body: string, origin?: string) =>
  app.request("/counters/demo/increment", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body,
  });

test("validates before invoking actors, including malformed and oversized bodies", async () => {
  for (const body of [
    "{",
    "null",
    "[]",
    '{"by":"2"}',
    '{"by":0}',
    '{"by":101}',
    '{"by":1.5}',
  ]) {
    assert.equal((await post(body)).status, 400, body);
  }
  assert.equal(
    (await post(JSON.stringify({ padding: "x".repeat(2000) }))).status,
    413,
  );
  assert.equal(
    (await post('{"by":1}', "https://untrusted.example")).status,
    403,
  );
  assert.equal(calls.length, 0);
  const response = await post('{"by":2}', "http://localhost:5173");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { count: 2 });
  assert.deepEqual(calls, [["demo", 2]]);
});

test("public config contains only browser configuration", async () => {
  assert.deepEqual(await (await app.request("/client-config")).json(), {
    rivetEndpoint: "http://localhost:6440",
    actorToken: null,
  });
});
