import { expect, test } from "bun:test";
import {
  OUTBOX_TABLE,
  createOutboxVars,
  enqueue,
  kickOutbox,
  outboxIdle,
  waiting,
  type OutboxHost,
  type OutboxRow,
} from "./outbox.ts";
import { memoryDatabase } from "./test-db.ts";

async function setup() {
  const db = memoryDatabase();
  await db.execute(OUTBOX_TABLE);
  const jobs = new Map<string, { interval: number; action: string }>();
  const host: OutboxHost = {
    db,
    vars: { outbox: createOutboxVars() },
    log: { warn: () => {} },
    keepAwake: (promise) => promise,
    cron: {
      every: async ({ name, ...job }) => jobs.set(name, job),
      delete: async (name) => jobs.delete(name),
    },
  };
  return { db, host, jobs };
}

test("repeated changes to one target coalesce into one delivery of the latest", async () => {
  const { db, host, jobs } = await setup();
  await db.transaction(async (tx) => {
    await enqueue(tx, "user", "grace");
    await enqueue(tx, "user", "grace");
    await enqueue(tx, "user", "linus");
  });
  const delivered: OutboxRow[] = [];
  kickOutbox(host, { deliver: async (row) => void delivered.push(row) });
  await outboxIdle(host);
  expect(delivered.map((r) => [r.target, r.version]).sort()).toEqual([
    ["grace", 2],
    ["linus", 1],
  ]);
  expect(await waiting(db, "user")).toEqual([]);
  expect(jobs.size).toBe(0);
});

test("a failure backs off and arms the retry job until it succeeds", async () => {
  const { db, host, jobs } = await setup();
  await db.transaction((tx) => enqueue(tx, "user", "grace"));
  let fail = true;
  const handlers = {
    deliver: async () => {
      if (fail) throw new Error("user actor asleep");
    },
  };
  kickOutbox(host, handlers);
  await outboxIdle(host);
  const [row] = await db.execute<{ attempts: number; due_at: number }>(
    "SELECT attempts, due_at FROM outbox",
  );
  expect(row!.attempts).toBe(1);
  expect(row!.due_at).toBeGreaterThan(Date.now());
  expect(jobs.get("outbox")).toEqual({
    interval: 10_000,
    action: "drainOutbox",
  });

  // Not due yet: a kick does not hammer the failing actor.
  kickOutbox(host, handlers);
  await outboxIdle(host);
  expect(await waiting(db, "user")).toEqual(["grace"]);

  fail = false;
  await db.execute("UPDATE outbox SET due_at = 0");
  kickOutbox(host, handlers);
  await outboxIdle(host);
  expect(await waiting(db, "user")).toEqual([]);
  expect(jobs.size).toBe(0);
});

test("a change during delivery is kept and delivered on the next pass", async () => {
  const { db, host } = await setup();
  await db.transaction((tx) => enqueue(tx, "user", "grace"));
  const versions: number[] = [];
  kickOutbox(host, {
    deliver: async (row) => {
      versions.push(row.version);
      // The organization changes again while the first view is in flight.
      if (row.version === 1)
        await db.transaction((tx) => enqueue(tx, "user", "grace"));
    },
  });
  await outboxIdle(host);
  expect(versions).toEqual([1, 2]);
  expect(await waiting(db, "user")).toEqual([]);
});
