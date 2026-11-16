import type { RawAccess } from "rivetkit/db";
import { LIMITS, type AuditEntry, type HistoryPage } from "./contracts.ts";

/**
 * The one write path for entity data, on the actor's own SQLite database.
 *
 * Every change runs in `commit`: one transaction writes the rows, bumps the
 * revision, appends an audit entry, and reads the new snapshot. The snapshot
 * is published only after the transaction commits, so no client ever sees a
 * change that rolled back. Views keep the snapshot with the highest revision,
 * so a late reply never overwrites a newer event.
 *
 * Rules that keep it correct:
 *   - Do every check that can fail inside `write`. A throw rolls back.
 *   - Never await another actor or `fetch` inside `write`. Do that before,
 *     or enqueue it in the outbox (`outbox.ts`) to run after commit.
 */

/** Tables every entity has. Run from the entity's first migration. */
export const LEDGER_TABLES = `
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL
);
`;

/** Anything that runs SQL: `c.db`, a transaction, or a migration's handle. */
export type Sql = Pick<RawAccess, "execute">;

/**
 * `execute`, typed with a row interface. `execute<T>` wants an index
 * signature, which plain interfaces like `Member` do not have.
 */
export async function select<T>(
  db: Sql,
  query: string,
  ...args: unknown[]
): Promise<T[]> {
  return (await db.execute(query, ...args)) as unknown as T[];
}

/** Seed the ledger row. Run once, after `LEDGER_TABLES`. */
export async function seedLedger(db: Sql): Promise<void> {
  const now = Date.now();
  await db.execute(
    "INSERT INTO ledger (id, revision, created_at, updated_at) VALUES (1, 0, ?, ?)",
    now,
    now,
  );
}

/** An audited change. */
export interface Change {
  by: string;
  action: string;
  summary: string;
}

/**
 * What `write` returns:
 *   - a `Change`: bump the revision and audit it,
 *   - `QUIET`: bump the revision without an audit entry (bookkeeping a
 *     viewer can still see, like a sync settling),
 *   - `null`: nothing changed. No revision, no publish.
 */
export const QUIET = "quiet" as const;
export type WriteResult = Change | typeof QUIET | null;

export interface Store<TSnapshot> {
  db: RawAccess;
  /** Read the full snapshot. Called inside the commit's transaction. */
  read: (db: RawAccess) => Promise<TSnapshot>;
  /** Send the snapshot to the connections allowed to see it. */
  publish: (snapshot: TSnapshot) => void;
}

export interface Meta {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export async function readMeta(db: Sql): Promise<Meta> {
  const [row] = await db.execute<{
    revision: number;
    created_at: number;
    updated_at: number;
  }>("SELECT revision, created_at, updated_at FROM ledger WHERE id = 1");
  if (!row)
    throw new Error("ledger row missing: run seedLedger in a migration");
  return {
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The newest audit entries for a snapshot, oldest first. */
export async function readAudit(
  db: Sql,
  limit: number = LIMITS.audit,
): Promise<AuditEntry[]> {
  const rows = await select<AuditEntry>(
    db,
    "SELECT id, at, by, action, summary FROM audit ORDER BY id DESC LIMIT ?",
    limit,
  );
  return rows.reverse();
}

/**
 * Older audit entries, a page at a time, oldest first. Pass the oldest `id`
 * you hold as `before`; omit it to start just before a snapshot's entries.
 */
export async function readHistory(
  db: Sql,
  before?: unknown,
): Promise<HistoryPage> {
  const cursor =
    typeof before === "number" && Number.isSafeInteger(before)
      ? before
      : await snapshotCursor(db);
  const rows = await select<AuditEntry>(
    db,
    "SELECT id, at, by, action, summary FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?",
    cursor,
    LIMITS.historyPage,
  );
  const oldest = rows.at(-1)?.id;
  const [older] =
    oldest === undefined
      ? []
      : await db.execute<{ id: number }>(
          "SELECT id FROM audit WHERE id < ? LIMIT 1",
          oldest,
        );
  return {
    entries: rows.reverse(),
    before: older && oldest !== undefined ? oldest : null,
  };
}

/** The id of the oldest audit entry a snapshot carries. */
async function snapshotCursor(db: Sql): Promise<number> {
  const rows = await db.execute<{ id: number }>(
    "SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET ?",
    LIMITS.audit - 1,
  );
  return rows[0]?.id ?? 0;
}

/** Read the snapshot in one transaction, so it is never half a change. */
export function snapshotOf<TSnapshot>(
  store: Pick<Store<TSnapshot>, "db" | "read">,
): Promise<TSnapshot> {
  return store.db.transaction((tx) => store.read(tx), { name: "snapshot" });
}

/**
 * Apply one change atomically and publish the result.
 *
 * `name` labels the transaction in Rivet's metrics: keep it static.
 */
export async function commit<TSnapshot>(
  store: Store<TSnapshot>,
  name: string,
  write: (tx: RawAccess) => Promise<WriteResult>,
): Promise<TSnapshot> {
  let changed = false;
  const next = await store.db.transaction(
    async (tx) => {
      const result = await write(tx);
      if (result !== null) {
        changed = true;
        const at = Date.now();
        await tx.execute(
          "UPDATE ledger SET revision = revision + 1, updated_at = ? WHERE id = 1",
          at,
        );
        if (result !== QUIET) {
          await tx.execute(
            "INSERT INTO audit (at, by, action, summary) VALUES (?, ?, ?, ?)",
            at,
            result.by,
            result.action,
            result.summary,
          );
          await tx.execute(
            "DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET ?)",
            LIMITS.auditRetained,
          );
        }
      }
      return store.read(tx);
    },
    { name },
  );
  if (changed) store.publish(next);
  return next;
}
