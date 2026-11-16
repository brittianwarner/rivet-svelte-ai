import { expect, test } from "bun:test";
import { LIMITS } from "./contracts.ts";
import {
  LEDGER_TABLES,
  QUIET,
  commit,
  readAudit,
  readHistory,
  readMeta,
  seedLedger,
  type Store,
} from "./store.ts";
import { memoryDatabase } from "./test-db.ts";

interface Snapshot {
  revision: number;
  notes: string[];
}

async function setup() {
  const db = memoryDatabase();
  await db.execute(LEDGER_TABLES);
  await seedLedger(db);
  await db.execute("CREATE TABLE notes (body TEXT NOT NULL)");
  const published: Snapshot[] = [];
  const store: Store<Snapshot> = {
    db,
    read: async (tx) => ({
      revision: (await readMeta(tx)).revision,
      notes: (await tx.execute<{ body: string }>("SELECT body FROM notes")).map(
        (row) => row.body,
      ),
    }),
    publish: (snapshot) => published.push(snapshot),
  };
  const add = (body: string) =>
    commit(store, "note.add", async (tx) => {
      await tx.execute("INSERT INTO notes (body) VALUES (?)", body);
      return { by: "ada", action: "note.add", summary: `Added ${body}` };
    });
  return { db, store, published, add };
}

test("a change bumps the revision, is audited, and publishes after commit", async () => {
  const { db, published, add } = await setup();
  const next = await add("first");
  expect(next).toEqual({ revision: 1, notes: ["first"] });
  expect(published).toEqual([next]);
  const [entry] = await readAudit(db);
  expect(entry).toMatchObject({
    by: "ada",
    action: "note.add",
    summary: "Added first",
  });
  expect(typeof entry!.id).toBe("number");
});

test("a throw rolls back the rows and the revision, and publishes nothing", async () => {
  const { db, store, published } = await setup();
  await expect(
    commit(store, "note.add", async (tx) => {
      await tx.execute("INSERT INTO notes (body) VALUES ('lost')");
      throw new Error("check failed");
    }),
  ).rejects.toThrow("check failed");
  expect(await store.read(db)).toEqual({ revision: 0, notes: [] });
  expect(await readAudit(db)).toEqual([]);
  expect(published).toEqual([]);
});

test("null changes nothing; QUIET bumps the revision without an audit entry", async () => {
  const { db, store, published } = await setup();
  expect(await commit(store, "noop", async () => null)).toEqual({
    revision: 0,
    notes: [],
  });
  expect(published).toEqual([]);
  expect((await commit(store, "sync", async () => QUIET)).revision).toBe(1);
  expect(published).toHaveLength(1);
  expect(await readAudit(db)).toEqual([]);
});

test("history pages backward from the snapshot's window without gaps", async () => {
  const { db, add } = await setup();
  const total = LIMITS.audit + LIMITS.historyPage + 7;
  for (let i = 0; i < total; i += 1) await add(`n${i}`);

  const recent = await readAudit(db);
  expect(recent).toHaveLength(LIMITS.audit);
  const first = await readHistory(db, recent[0]!.id);
  expect(first.entries).toHaveLength(LIMITS.historyPage);
  expect(first.entries.at(-1)!.id).toBe(recent[0]!.id - 1);
  // Omitting `before` starts at the same place.
  expect(await readHistory(db)).toEqual(first);

  const last = await readHistory(db, first.before);
  expect(last.entries).toHaveLength(7);
  expect(last.before).toBeNull();
  const ids = [...last.entries, ...first.entries, ...recent].map((e) => e.id);
  expect(new Set(ids).size).toBe(total);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
});

test("the audit keeps the newest LIMITS.auditRetained entries", async () => {
  const { db, add } = await setup();
  for (let i = 0; i < LIMITS.auditRetained + 3; i += 1) await add(`n${i}`);
  const [count] = await db.execute<{ n: number }>(
    "SELECT count(*) AS n FROM audit",
  );
  expect(count!.n).toBe(LIMITS.auditRetained);
  // The three oldest went first.
  const [oldest] = await readAudit(db, LIMITS.auditRetained);
  expect(oldest!.summary).toBe("Added n3");
});
