import assert from "node:assert/strict";
import { test } from "bun:test";
import { session } from "./session.ts";
import { migratedDatabase, type MemoryDatabase } from "./test-db.ts";
import {
  SESSION_ACTOR_LIMIT,
  sessionCounterKey,
  type SessionSnapshot,
  type SessionValue,
} from "@example/wire";

const actions = session.config.actions!;
type Context = Parameters<typeof actions.createCounter>[0];

/** A session context whose child counters answer through `getCount`. */
function context(input: {
  id: string;
  db: MemoryDatabase;
  changes: SessionSnapshot[];
  values?: SessionValue[];
  getCount?: () => Promise<number>;
  counts?: Map<string, number>;
  disposed?: string[];
}): Context {
  const counts = input.counts ?? new Map<string, number>();
  const counter = (key: string, create = false) => ({
    getCount: (create && input.getCount) || (async () => counts.get(key) ?? 0),
    async increment(by: number) {
      const next = (counts.get(key) ?? 0) + by;
      counts.set(key, next);
      return next;
    },
    connect: () => ({
      on() {},
      async dispose() {
        input.disposed?.push(key);
      },
    }),
  });
  return {
    key: [input.id],
    db: input.db,
    vars: {
      subs: new Map(),
      counts: new Map(),
      generation: new Map(),
      inflight: new Map(),
    },
    broadcast(event: string, value: unknown) {
      if (event === "changed") input.changes.push(value as SessionSnapshot);
      else input.values?.push(value as SessionValue);
    },
    client() {
      return {
        counter: {
          get: (key: [string, string]) => counter(key[1]),
          getOrCreate: (key: [string, string]) => counter(key[1], true),
        },
      };
    },
  } as unknown as Context;
}

function requestCount(db: MemoryDatabase): number {
  return (
    db.sqlite.prepare("SELECT count(*) AS n FROM create_requests").get() as {
      n: number;
    }
  ).n;
}

test("a failed child creation retains one reservation and the same request safely retries", async () => {
  const id = crypto.randomUUID();
  const request = crypto.randomUUID();
  const changes: SessionSnapshot[] = [];
  let attempts = 0;
  const c = context({
    id,
    db: await migratedDatabase(session),
    changes,
    async getCount() {
      if (++attempts === 1) throw new Error("Temporary child engine failure");
      return 0;
    },
  });
  await assert.rejects(
    actions.createCounter(c, request),
    /Temporary child engine failure/,
  );
  const reserved = await actions.getSnapshot(c);
  assert.equal(reserved.actors.length, 1);
  assert.equal(reserved.revision, 1);
  assert.equal(reserved.actors[0].key, sessionCounterKey(id, request));
  const restored = await actions.createCounter(c, request);
  assert.equal(attempts, 2);
  assert.deepEqual(restored, reserved);
  assert.equal(
    changes.length,
    1,
    "retry does not rebroadcast a duplicate membership reservation",
  );
});

test("removal is idempotent, an emptied session stays empty, and retry history is bounded", async () => {
  const changes: SessionSnapshot[] = [];
  const db = await migratedDatabase(session);
  const c = context({ id: crypto.randomUUID(), db, changes });
  const starter = (await actions.ensureStarter(c)).actors[0];
  assert.equal(starter.label, "counter-01");
  await actions.removeCounter(c, starter.key);
  const { revision } = await actions.getSnapshot(c);
  await actions.removeCounter(c, starter.key);
  assert.equal(
    (await actions.getSnapshot(c)).revision,
    revision,
    "repeated removal is a no-op",
  );
  assert.deepEqual(
    (await actions.ensureStarter(c)).actors,
    [],
    "reload does not recreate a removed starter",
  );
  const request = crypto.randomUUID();
  const created = (await actions.createCounter(c, request)).actors[0];
  assert.equal(created.label, "counter-02");
  await actions.removeCounter(c, created.key);
  assert.deepEqual(
    (await actions.createCounter(c, request)).actors,
    [],
    "late create retries do not resurrect removed actors",
  );
  assert.deepEqual(
    (await actions.attachCounter(c, created.key, created.label)).actors,
    [created],
    "undo restores the original key and label",
  );
  await actions.removeCounter(c, created.key);
  for (let i = 0; i < 70; i++) {
    const [added] = (await actions.createCounter(c, crypto.randomUUID()))
      .actors;
    await actions.removeCounter(c, added.key);
  }
  assert.equal(requestCount(db), 64);
  assert.deepEqual(changes.at(-1)?.actors, []);
});

test("concurrent admission never exceeds the cap while children are pending", async () => {
  const changes: SessionSnapshot[] = [];
  const c = context({
    id: crypto.randomUUID(),
    db: await migratedDatabase(session),
    changes,
    getCount: () => Bun.sleep(5).then(() => 0),
  });
  const settled = await Promise.allSettled(
    Array.from({ length: SESSION_ACTOR_LIMIT + 3 }, () =>
      actions.createCounter(c, crypto.randomUUID()),
    ),
  );
  const refused = settled.filter((result) => result.status === "rejected");
  assert.equal(settled.length - refused.length, SESSION_ACTOR_LIMIT);
  for (const result of refused)
    assert.equal((result as PromiseRejectedResult).reason.code, "SESSION_FULL");
  const full = await actions.getSnapshot(c);
  assert.equal(full.actors.length, SESSION_ACTOR_LIMIT);
  assert.equal(full.revision, SESSION_ACTOR_LIMIT);
  assert.equal(
    new Set(full.actors.map((a) => a.label)).size,
    SESSION_ACTOR_LIMIT,
  );
  assert.deepEqual(
    changes.map((snapshot) => snapshot.revision),
    Array.from({ length: SESSION_ACTOR_LIMIT }, (_, i) => i + 1),
    "each admission broadcasts its own committed snapshot, in order",
  );
});

test("the first migration carries pre-3.0 membership and retry history forward", async () => {
  const id = crypto.randomUUID();
  const request = crypto.randomUUID();
  const key = sessionCounterKey(id, request);
  const legacyState = {
    actors: [
      { key: `session-${id}-01`, label: "counter-01" },
      { key, label: "counter-02" },
    ],
    revision: 5,
    requests: { [request]: key },
    nextOrdinal: 3,
  };
  const db = await migratedDatabase(session, { legacyState });
  const c = context({ id, db, changes: [] });
  assert.deepEqual(await actions.getSnapshot(c), {
    actors: legacyState.actors,
    revision: 5,
  });
  assert.deepEqual(
    (await actions.createCounter(c, request)).revision,
    5,
    "an imported request id still retries idempotently",
  );
  const added = await actions.createCounter(c, crypto.randomUUID());
  assert.equal(added.actors.at(-1)?.label, "counter-03");

  for (const malformed of [
    { ...legacyState, revision: -1 },
    { ...legacyState, actors: [{ key: "Not A Key", label: "counter-01" }] },
    { ...legacyState, requests: { "not-a-uuid": key } },
    null,
  ]) {
    const fresh = context({
      id,
      db: await migratedDatabase(session, { legacyState: malformed }),
      changes: [],
    });
    assert.deepEqual(await actions.getSnapshot(fresh), {
      actors: [],
      revision: 0,
    });
  }
});

test("the session relays member counts over its own socket and drops removed members", async () => {
  const id = crypto.randomUUID();
  const changes: SessionSnapshot[] = [];
  const values: SessionValue[] = [];
  const disposed: string[] = [];
  const counts = new Map<string, number>();
  const c = context({
    id,
    db: await migratedDatabase(session),
    changes,
    values,
    counts,
    disposed,
  });
  const [starter] = (await actions.ensureStarter(c)).actors;
  assert.deepEqual(await actions.getValues(c), [
    { key: starter.key, count: 0 },
  ]);
  assert.equal(await actions.increment(c, starter.key), 1);
  assert.deepEqual(values.at(-1), { key: starter.key, count: 1 });
  await assert.rejects(
    actions.increment(c, "not-a-member"),
    /not in this session/,
  );
  await actions.removeCounter(c, starter.key);
  assert.deepEqual(
    disposed,
    [starter.key],
    "removal disposes the subscription",
  );
  assert.deepEqual(await actions.getValues(c), []);
  assert.equal(counts.get(starter.key), 1, "removal never touches the counter");
});
