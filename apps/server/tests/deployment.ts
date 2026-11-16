/**
 * Acceptance test for a running deployment (local or hosted).
 *
 *   bun run test:deployment https://your-domain
 *
 * Writes only to its own counter. Checks the browser path end to end:
 * same-origin /rivet edge, actions, WebSocket events, the HTTP API, engine
 * admin routes denied at the edge, and that fresh connections (which a load
 * balancer spreads across replicas) all see one actor.
 */
import assert from "node:assert/strict";
import { createClient } from "rivetkit/client";
import type { ClientConfig } from "@example/wire";
import type { AppRegistry } from "@example/actors";

const origin = process.argv[2];
if (!origin)
  throw new Error("Usage: bun run test:deployment https://your-domain");
const base = new URL(origin);
if (
  base.pathname !== "/" ||
  base.search ||
  base.hash ||
  base.username ||
  base.password
) {
  throw new Error("Pass only the origin, without a path or credentials.");
}

const configResponse = await fetch(new URL("/api/client-config", base), {
  headers: { origin: base.origin },
});
assert.ok(configResponse.ok, "client config must load");
const config = (await configResponse.json()) as ClientConfig;
assert.equal(
  new URL(config.rivetEndpoint).origin,
  base.origin,
  "browser talks to this origin only",
);
assert.equal(
  new URL(config.rivetEndpoint).pathname,
  "/rivet",
  "through the /rivet edge",
);

const connect = () =>
  createClient<AppRegistry>({
    endpoint: config.rivetEndpoint,
    namespace: config.rivetNamespace,
    // The edge denies /actors; actions resolve through the gateway query.
    gateway: { skipReadyWait: true },
    disableMetadataLookup: true,
    headers: { origin: base.origin },
  });

const timeout = setTimeout(() => {
  console.error("Deployment acceptance timed out");
  process.exit(1);
}, 90_000);
const key = process.env.SMOKE_ACTOR_KEY || `acceptance-${crypto.randomUUID()}`;
const params = config.actorToken ? { token: config.actorToken } : {};
const client = connect();

try {
  const counter = client.counter.getOrCreate(["counter", key], { params });
  const before = await counter.getCount();
  if (process.env.SMOKE_EXPECT_COUNT !== undefined) {
    assert.equal(
      before,
      Number(process.env.SMOKE_EXPECT_COUNT),
      "count survives restart",
    );
  }

  const connection = counter.connect();
  let eventCount: number | undefined;
  connection.on("newCount", (count) => {
    eventCount = count;
  });
  await connection.getCount();
  assert.equal(await counter.increment(1), before + 1);
  for (let i = 0; i < 100 && eventCount !== before + 1; i++)
    await Bun.sleep(50);
  assert.equal(eventCount, before + 1, "the WebSocket delivers the update");
  await connection.dispose();

  const http = await fetch(new URL(`/api/counters/${key}/increment`, base), {
    method: "POST",
    headers: { "content-type": "application/json", origin: base.origin },
    body: JSON.stringify({ by: 2 }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(http.status, 200);
  assert.equal(((await http.json()) as { count: number }).count, before + 3);

  // Fresh clients land on whichever replica the balancer picks. One actor, one count.
  let expected = before + 3;
  for (let i = 0; i < 6; i++) {
    const fresh = connect();
    try {
      expected += 1;
      assert.equal(
        await fresh.counter
          .getOrCreate(["counter", key], { params })
          .increment(1),
        expected,
      );
    } finally {
      await fresh.dispose();
    }
  }

  for (const path of [
    "/rivet/namespaces",
    "/rivet/actors",
    "/rivet/pools/default/nodes",
    "/rivet/auth/tokens",
    "/rivet/envoys/connect",
  ]) {
    const denied = await fetch(new URL(path, base), {
      headers: { origin: base.origin },
    });
    assert.equal(denied.status, 404, `${path} is denied at the edge`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      actorKey: key,
      count: expected,
      checks: [
        "same-origin-edge",
        "action",
        "websocket-event",
        "http-action",
        "replica-consistency",
        "admin-denied",
      ],
    }),
  );
} finally {
  clearTimeout(timeout);
  await client.dispose();
}
