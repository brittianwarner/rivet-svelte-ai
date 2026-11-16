import assert from "node:assert/strict";
import { test } from "bun:test";
import { counter } from "./counter.ts";
import { migratedDatabase, type MemoryDatabase } from "./test-db.ts";

const actions = counter.config.actions!;
type Context = Parameters<typeof actions.increment>[0];

function context(db: MemoryDatabase, events: number[] = []): Context {
  return {
    db,
    broadcast: (_name: string, value: number) => events.push(value),
  } as unknown as Context;
}

test("concurrent increments are one statement each and none is lost", async () => {
  const events: number[] = [];
  const c = context(await migratedDatabase(counter), events);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => actions.increment(c, 5)),
  );
  assert.equal(await actions.getCount(c), 100);
  assert.deepEqual(
    results.toSorted((a, b) => a - b),
    Array.from({ length: 20 }, (_, i) => (i + 1) * 5),
  );
  assert.deepEqual(events, results, "each increment broadcasts its result");
});

test("increments are validated and stop at the safe-integer limit", async () => {
  const db = await migratedDatabase(counter);
  const c = context(db);
  for (const by of [0, 101, 1.5, Number.NaN])
    await assert.rejects(actions.increment(c, by), {
      code: "VALIDATION_FAILED",
    });
  db.sqlite.run(`UPDATE counter SET count = ${Number.MAX_SAFE_INTEGER - 1}`);
  assert.equal(await actions.increment(c, 1), Number.MAX_SAFE_INTEGER);
  await assert.rejects(actions.increment(c, 1), { code: "COUNTER_LIMIT" });
  assert.equal(await actions.getCount(c), Number.MAX_SAFE_INTEGER);
});

test("the first migration carries a pre-3.0 count forward", async () => {
  const imported = context(
    await migratedDatabase(counter, { legacyState: { count: 41 } }),
  );
  assert.equal(await actions.getCount(imported), 41);
  assert.equal(await actions.increment(imported, 1), 42);

  for (const legacyState of [{ count: -1 }, { count: "7" }, [1], "oops"]) {
    const fresh = context(await migratedDatabase(counter, { legacyState }));
    assert.equal(await actions.getCount(fresh), 0, JSON.stringify(legacyState));
  }
});
