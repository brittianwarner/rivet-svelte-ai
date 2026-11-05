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

test("actor readiness fails closed while process liveness stays healthy", async () => {
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await app.request("/health/actors")).status, 503);
  let ready = false;
  let fail = false;
  const checked = createApp({
    origins: [],
    endpoint: () => "http://localhost:6440",
    token: () => null,
    provider: () => ({ provider: "none", modelId: null }),
    increment: async () => 1,
    actorHealthy: async () => {
      if (fail) throw new Error("internal details");
      return ready;
    },
  });
  assert.equal((await checked.request("/health/actors")).status, 503);
  ready = true;
  assert.equal((await checked.request("/health/actors")).status, 200);
  fail = true;
  const failure = await checked.request("/health/actors");
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { ok: false });
});

test("browser credentials are uncached, origin-checked, and fail without exposing secrets", async () => {
  let fail = false;
  let issued = 0;
  const hosted = createApp({
    origins: ["https://starter.example"],
    endpoint: () => "https://engine.example",
    token: () => null,
    provider: () => ({ provider: "none", modelId: null }),
    increment: async () => 1,
    issueBrowserToken: async () => {
      issued++;
      if (fail) throw new Error("sensitive upstream error");
      return { token: "scoped-token", expiresAt: 123 };
    },
  });
  const request = (origin: string) =>
    hosted.request("/client-token", {
      method: "POST",
      headers: { origin },
    });
  assert.equal((await request("https://untrusted.example")).status, 403);
  assert.equal(issued, 0);
  const response = await request("https://starter.example");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    token: "scoped-token",
    expiresAt: 123,
  });
  assert.equal(
    (await (await hosted.request("/client-config")).json()).authenticatedEngine,
    true,
  );
  fail = true;
  const failure = await request("https://starter.example");
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /sensitive/);
  assert.equal(
    (await app.request("/client-token", { method: "POST" })).status,
    404,
  );
});
