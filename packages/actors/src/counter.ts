import { actor, event, UserError } from "rivetkit";
import { db } from "rivetkit/db";
import { migrations } from "rivetkit/unstable/migrations";
import { authorizeConnection } from "./auth.ts";
import { isCount, isRecord, readLegacyState } from "./legacy-state.ts";

/** The pre-3.0 `{ count }` state, or 0 when there is none or it is malformed. */
function legacyCount(state: unknown): number {
  return isRecord(state) && isCount(state.count) ? state.count : 0;
}

/** One number per actor key, kept in the actor's own SQLite database. */
export const counter = actor({
  db: db({
    onMigrate: migrations({
      migrations: [
        {
          version: 1,
          up: async (db) => {
            await db.execute(
              "CREATE TABLE counter (id INTEGER PRIMARY KEY CHECK (id = 1), count INTEGER NOT NULL)",
            );
            await db.execute(
              "INSERT INTO counter (id, count) VALUES (1, ?)",
              legacyCount(await readLegacyState(db)),
            );
          },
        },
      ],
    }),
  }),
  events: { newCount: event<number>() },
  onBeforeConnect: (c, params) => {
    authorizeConnection(c, params);
  },
  actions: {
    getCount: async (c): Promise<number> => {
      const [row] = await c.db.execute<{ count: number }>(
        "SELECT count FROM counter WHERE id = 1",
      );
      return row.count;
    },
    increment: async (c, by: number): Promise<number> => {
      if (!Number.isInteger(by) || by < 1 || by > 100) {
        throw new UserError("Increment must be a whole number from 1 to 100.", {
          code: "VALIDATION_FAILED",
        });
      }
      // One statement reads, checks and writes, so concurrent increments
      // cannot interleave between a read and a write.
      const [row] = await c.db.execute<{ count: number }>(
        "UPDATE counter SET count = count + :by WHERE id = 1 AND count + :by <= :max RETURNING count",
        { by, max: Number.MAX_SAFE_INTEGER },
      );
      if (!row) {
        throw new UserError("Counter limit reached.", {
          code: "COUNTER_LIMIT",
        });
      }
      c.broadcast("newCount", row.count);
      return row.count;
    },
  },
});
