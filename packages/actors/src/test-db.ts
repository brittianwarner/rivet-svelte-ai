/**
 * Test support: an in-memory stand-in for `c.db`, so actor actions run in
 * `bun test` without an engine. It keeps the parts of RivetKit's contract the
 * actors rely on: row objects, positional or named bindings (and the same
 * refusal of booleans and `undefined`), multi-statement SQL without
 * bindings, and one transaction at a time that commits on resolve and rolls
 * back on throw. Statements outside a transaction wait for it to finish.
 */
import { Database } from "bun:sqlite";
import { encode } from "cbor-x";
import type { RawAccess } from "rivetkit/db";

type Binding = string | number | bigint | null | Uint8Array;
type Bindings = Binding[] | Record<string, Binding>;

function isBinding(value: unknown): value is Binding {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  );
}

function toBindings(args: unknown[]): Bindings {
  const [first] = args;
  const named =
    args.length === 1 &&
    typeof first === "object" &&
    first !== null &&
    Object.getPrototypeOf(first) === Object.prototype;
  const values = named ? Object.values(first as object) : args;
  if (!values.every(isBinding))
    throw new Error("unsupported sqlite binding type");
  return named ? (first as Record<string, Binding>) : (values as Binding[]);
}

export interface MemoryDatabase extends RawAccess {
  /** The underlying database, for seeding tables a test needs. */
  sqlite: Database;
}

export function memoryDatabase(): MemoryDatabase {
  const sqlite = new Database(":memory:", { strict: true });
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  const run = <TRow>(sql: string, args: unknown[]): TRow[] => {
    if (args.length === 0 && sql.trim().replace(/;+$/, "").includes(";")) {
      sqlite.run(sql);
      return [];
    }
    const statement = sqlite.prepare(sql);
    const bindings = toBindings(args);
    return (
      Array.isArray(bindings)
        ? statement.all(...bindings)
        : statement.all(bindings)
    ) as TRow[];
  };
  const inTransaction: RawAccess = {
    execute: async (sql, ...args) => run(sql, args),
    transaction: () => {
      throw new Error("nested transactions are not supported");
    },
    close: async () => {},
  };
  return {
    sqlite,
    execute: (sql, ...args) => exclusive(async () => run(sql, args)),
    transaction: (callback) =>
      exclusive(async () => {
        sqlite.run("BEGIN");
        try {
          const result = await callback(inTransaction);
          sqlite.run("COMMIT");
          return result;
        } catch (error) {
          sqlite.run("ROLLBACK");
          throw error;
        }
      }),
    close: async () => sqlite.close(),
  };
}

/**
 * A database with an actor's migrations applied, the way RivetKit runs them.
 * `legacyState` seeds the pre-3.0 state row first, in RivetKit's layout.
 */
export async function migratedDatabase(
  definition: { config: unknown },
  options: { legacyState?: unknown } = {},
): Promise<MemoryDatabase> {
  const database = memoryDatabase();
  if ("legacyState" in options) {
    database.sqlite.run(
      "CREATE TABLE _rivet_actor_state (id INTEGER PRIMARY KEY CHECK (id = 1), state BLOB NOT NULL)",
    );
    database.sqlite
      .prepare("INSERT INTO _rivet_actor_state (id, state) VALUES (1, ?)")
      .run(encode(options.legacyState));
  }
  // `ActorConfig` is a union RivetKit narrows internally; read just the provider.
  const { db } = definition.config as {
    db?: { onMigrate: (client: RawAccess) => void | Promise<void> };
  };
  await db?.onMigrate(database);
  return database;
}
