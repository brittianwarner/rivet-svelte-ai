import assert from "node:assert/strict";
import { createClient } from "rivetkit/client";
import {
  COUNTER_NAME_PATTERN,
  SESSION_ACTOR_LIMIT,
  sessionCounterKey,
  type ClientConfig,
  type SessionSnapshot,
} from "@example/wire";
import type { registry } from "../src/actors.ts";

const origin = process.env.SMOKE_API_ORIGIN || "http://127.0.0.1:3002";
const local = (value: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
assert.ok(local(origin), "Session acceptance only targets a local API.");
const configResponse = await fetch(`${origin}/client-config`, {
  signal: AbortSignal.timeout(10_000),
});
assert.ok(configResponse.ok, "Client configuration must be available.");
const config = (await configResponse.json()) as ClientConfig;
assert.ok(
  local(config.rivetEndpoint),
  "Session acceptance only creates actors on a local engine.",
);
const client = createClient<typeof registry>(config.rivetEndpoint);
const params = config.actorToken ? { token: config.actorToken } : {};
const options = { params };
let disposedClient = false;
const timeout = setTimeout(() => {
  console.error("Session integration timed out");
  process.exit(1);
}, 45_000);
async function until(read: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Session event did not settle.");
}
try {
  const id = crypto.randomUUID();
  const handle = client.session.getOrCreate([id], options);
  const connection = handle.connect();
  const events: SessionSnapshot[] = [];
  connection.on("changed", (snapshot) => events.push(snapshot));
  assert.deepEqual(await connection.getSnapshot(), { actors: [], revision: 0 });
  const starters = await Promise.all([
    connection.ensureStarter(),
    handle.ensureStarter(),
    handle.ensureStarter(),
  ]);
  for (const snapshot of starters) assert.equal(snapshot.actors.length, 1);
  const starter = (await handle.getSnapshot()).actors[0];
  assert.equal(starter.key, `session-${id}-01`);
  assert.equal(starter.label, "counter-01");
  assert.equal(
    await client.counter
      .getOrCreate(["counter", starter.key], options)
      .getCount(),
    0,
  );

  const request = crypto.randomUUID();
  const duplicate = await Promise.all([
    connection.createCounter(request),
    handle.createCounter(request),
    handle.createCounter(request),
  ]);
  for (const snapshot of duplicate) assert.equal(snapshot.actors.length, 2);
  const createdKey = sessionCounterKey(id, request);
  assert.equal(createdKey.length, 64);
  assert.ok(COUNTER_NAME_PATTERN.test(createdKey));
  assert.ok(
    (await handle.getSnapshot()).actors.some(
      (actor) => actor.key === createdKey,
    ),
  );
  assert.equal(
    await client.counter
      .getOrCreate(["counter", createdKey], options)
      .increment(3),
    3,
  );
  assert.equal(
    await client.counter
      .getOrCreate(["counter", starter.key], options)
      .getCount(),
    0,
  );
  await until(async () =>
    events.some((snapshot) =>
      snapshot.actors.some((actor) => actor.key === createdKey),
    ),
  );

  const secondId = crypto.randomUUID();
  const other = client.session.getOrCreate([secondId], options);
  const second = await other.ensureStarter();
  assert.notEqual(second.actors[0].key, starter.key);
  // The same request UUID in a different visitor session must create a different counter.
  await other.createCounter(request);
  const otherKey = sessionCounterKey(secondId, request);
  assert.notEqual(otherKey, createdKey);
  assert.equal(
    await client.counter.getOrCreate(["counter", otherKey], options).getCount(),
    0,
  );

  // Valid callers may populate membership before ever requesting a starter.
  const fullWithoutStarter = client.session.getOrCreate(
    [crypto.randomUUID()],
    options,
  );
  await Promise.all(
    Array.from({ length: SESSION_ACTOR_LIMIT }, () =>
      fullWithoutStarter.createCounter(crypto.randomUUID()),
    ),
  );
  const existingFull = await fullWithoutStarter.getSnapshot();
  assert.equal(existingFull.actors.length, SESSION_ACTOR_LIMIT);
  assert.deepEqual(
    await fullWithoutStarter.ensureStarter(),
    existingFull,
    "restoring an existing full registry must not reserve an eighth starter",
  );

  // Attach is explicit membership of a counter; repeating it cannot duplicate or consume slots.
  const externalKey = `shared-${crypto.randomUUID()}`;
  await client.counter
    .getOrCreate(["counter", externalKey], options)
    .increment(4);
  await Promise.all([
    handle.attachCounter(externalKey),
    handle.attachCounter(externalKey),
  ]);
  const attached = await handle.getSnapshot();
  assert.equal(attached.actors.length, 3);
  assert.equal(
    attached.actors.filter((actor) => actor.key === externalKey).length,
    1,
  );
  assert.equal(
    await client.counter
      .getOrCreate(["counter", externalKey], options)
      .getCount(),
    4,
  );
  await assert.rejects(handle.createCounter("not-a-uuid"));
  await assert.rejects(handle.attachCounter("Invalid Key"));
  await assert.rejects(handle.attachCounter("x".repeat(65)));
  await assert.rejects(
    client.session.getOrCreate(["not-a-uuid"], options).getSnapshot(),
  );

  // Admission is bounded even while real child getOrCreate requests are awaiting the engine.
  const admitted = await Promise.allSettled(
    Array.from({ length: 8 }, () => handle.createCounter(crypto.randomUUID())),
  );
  assert.equal(
    admitted.filter((result) => result.status === "fulfilled").length,
    4,
  );
  const full = await handle.getSnapshot();
  assert.equal(full.actors.length, SESSION_ACTOR_LIMIT);
  assert.equal(full.revision, SESSION_ACTOR_LIMIT);
  assert.equal(
    new Set(full.actors.map((actor) => actor.key)).size,
    SESSION_ACTOR_LIMIT,
  );
  assert.equal(
    new Set(full.actors.map((actor) => actor.label)).size,
    SESSION_ACTOR_LIMIT,
  );
  for (const actor of full.actors)
    assert.ok(
      Number.isInteger(
        await client.counter
          .getOrCreate(["counter", actor.key], options)
          .getCount(),
      ),
    );
  // A retried accepted request must still succeed at the cap without allocating anything.
  assert.deepEqual(await handle.createCounter(request), full);
  assert.deepEqual(await handle.attachCounter(externalKey), full);
  await assert.rejects(handle.createCounter(crypto.randomUUID()));
  await connection.dispose();
  assert.deepEqual(await handle.getSnapshot(), full);
  await client.dispose();
  disposedClient = true;
  const freshClient = createClient<typeof registry>(config.rivetEndpoint);
  try {
    assert.deepEqual(
      await freshClient.session.getOrCreate([id], options).getSnapshot(),
      full,
    );
  } finally {
    await freshClient.dispose();
  }
  console.log(
    "session integration passed: real actors, request idempotency, isolation, bounded concurrent admission, events, and reconnect restoration",
  );
} finally {
  clearTimeout(timeout);
  if (!disposedClient) await client.dispose();
}
