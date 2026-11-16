import { actor, event, UserError } from "rivetkit";
import type { Client } from "rivetkit/client";
import { db, type RawAccess } from "rivetkit/db";
import {
  migrations,
  type MigrationDatabase,
} from "rivetkit/unstable/migrations";
import {
  COUNTER_NAME_PATTERN,
  SESSION_ACTOR_LIMIT,
  SESSION_ID_PATTERN,
  sessionCounterKey,
  type SessionActorRecord,
  type SessionSnapshot,
} from "@example/wire";
import type { AppRegistry } from "./registry.ts";
import { authorizeConnection, serverActorParams } from "./auth.ts";
import { isCount, isRecord, readLegacyState } from "./legacy-state.ts";

/** How many recent create requests are kept for idempotent retries. */
const REQUEST_HISTORY = 64;
const LABEL_PATTERN = /^counter-[0-9]{2,10}$/;

type Database = Pick<RawAccess, "execute">;

function sessionId(key: string[]): string {
  if (key.length !== 1 || !SESSION_ID_PATTERN.test(key[0])) {
    throw new UserError("A session key must be one canonical UUID.", {
      code: "VALIDATION_FAILED",
    });
  }
  return key[0];
}

/**
 * Members and revision in one statement, so the snapshot is consistent even
 * outside a transaction. The join keeps the revision when there are no members.
 */
async function readSnapshot(db: Database): Promise<SessionSnapshot> {
  const rows = await db.execute<{
    revision: number;
    key: string | null;
    label: string | null;
  }>(
    `SELECT session.revision, members.key, members.label
     FROM session LEFT JOIN members ON true
     ORDER BY members.position`,
  );
  const actors: SessionActorRecord[] = [];
  for (const { key, label } of rows)
    if (key !== null && label !== null) actors.push({ key, label });
  return { actors, revision: rows[0].revision };
}

/**
 * Add a member inside the caller's transaction. Returns the new snapshot, or
 * null when the key was already a member. The cap check and the insert share
 * the transaction, so concurrent calls cannot exceed the limit.
 */
async function reserve(
  tx: Database,
  member: { key: string; label?: string },
): Promise<SessionSnapshot | null> {
  const current = await readSnapshot(tx);
  if (current.actors.some((record) => record.key === member.key)) return null;
  if (current.actors.length >= SESSION_ACTOR_LIMIT) {
    throw new UserError("This session already has seven actors.", {
      code: "SESSION_FULL",
    });
  }
  let label = member.label;
  if (label === undefined) {
    const [row] = await tx.execute<{ ordinal: number }>(
      "UPDATE session SET next_ordinal = next_ordinal + 1 RETURNING next_ordinal - 1 AS ordinal",
    );
    label = `counter-${String(row.ordinal).padStart(2, "0")}`;
  }
  await tx.execute(
    "INSERT INTO members (key, label) VALUES (?, ?)",
    member.key,
    label,
  );
  await tx.execute("UPDATE session SET revision = revision + 1");
  return readSnapshot(tx);
}

/**
 * Make sure the child counter exists. Runs after the membership commits:
 * if the engine is briefly unavailable the reservation stays, and retrying
 * the same action retries the same child rather than allocating another.
 */
async function openCounter(
  client: Client<AppRegistry>,
  key: string,
): Promise<void> {
  await client.counter
    .getOrCreate(["counter", key], { params: serverActorParams() })
    .getCount();
}

interface LegacySession {
  actors: SessionActorRecord[];
  revision: number;
  nextOrdinal: number;
  requests: [requestId: string, key: string][];
}

/** The pre-3.0 state, or null unless every field has the shape this actor wrote. */
function legacySession(state: unknown): LegacySession | null {
  if (
    !isRecord(state) ||
    !Array.isArray(state.actors) ||
    !isCount(state.revision) ||
    !isCount(state.nextOrdinal) ||
    !isRecord(state.requests)
  ) {
    return null;
  }
  const actors: SessionActorRecord[] = [];
  for (const record of state.actors) {
    if (
      !isRecord(record) ||
      typeof record.key !== "string" ||
      !COUNTER_NAME_PATTERN.test(record.key) ||
      typeof record.label !== "string" ||
      !LABEL_PATTERN.test(record.label) ||
      actors.some((seen) => seen.key === record.key)
    ) {
      return null;
    }
    actors.push({ key: record.key, label: record.label });
  }
  const requests = Object.entries(state.requests);
  if (
    actors.length > SESSION_ACTOR_LIMIT ||
    requests.some(
      ([request, key]) =>
        !SESSION_ID_PATTERN.test(request) ||
        typeof key !== "string" ||
        !COUNTER_NAME_PATTERN.test(key),
    )
  ) {
    return null;
  }
  return {
    actors,
    revision: state.revision,
    nextOrdinal: state.nextOrdinal,
    requests: (requests as [string, string][]).slice(-REQUEST_HISTORY),
  };
}

async function createSchema(db: MigrationDatabase): Promise<void> {
  await db.execute(`
    CREATE TABLE session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      next_ordinal INTEGER NOT NULL
    );
    CREATE TABLE members (
      position INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL
    );
    CREATE TABLE create_requests (
      seq INTEGER PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      key TEXT NOT NULL
    );
  `);
  const legacy = legacySession(await readLegacyState(db));
  await db.execute(
    "INSERT INTO session (id, revision, next_ordinal) VALUES (1, ?, ?)",
    legacy?.revision ?? 0,
    legacy?.nextOrdinal ?? 2,
  );
  for (const { key, label } of legacy?.actors ?? [])
    await db.execute(
      "INSERT INTO members (key, label) VALUES (?, ?)",
      key,
      label,
    );
  for (const [request, key] of legacy?.requests ?? [])
    await db.execute(
      "INSERT INTO create_requests (request_id, key) VALUES (?, ?)",
      request,
      key,
    );
}

/**
 * One persistent membership registry per visitor UUID; counters own their own
 * data. Every membership change is one transaction that checks the cap,
 * writes, bumps the revision and reads the snapshot it broadcasts after commit.
 */
export const session = actor({
  db: db({
    onMigrate: migrations({
      migrations: [{ version: 1, up: createSchema }],
    }),
  }),
  events: { changed: event<SessionSnapshot>() },
  onBeforeConnect: (c, params) => {
    authorizeConnection(c, params);
    sessionId(c.key);
  },
  actions: {
    getSnapshot: (c): Promise<SessionSnapshot> => {
      sessionId(c.key);
      return readSnapshot(c.db);
    },
    ensureStarter: async (c): Promise<SessionSnapshot> => {
      const id = sessionId(c.key);
      const starter = await c.db.transaction(
        async (tx) => {
          const current = await readSnapshot(tx);
          // An intentionally emptied session must stay empty on reload.
          if (current.actors.length === 0 && current.revision > 0) return null;
          const key = current.actors[0]?.key ?? `session-${id}-01`;
          const changed =
            current.actors.length === 0
              ? await reserve(tx, { key, label: "counter-01" })
              : null;
          return { key, changed };
        },
        { name: "session-ensure-starter" },
      );
      if (starter === null) return readSnapshot(c.db);
      if (starter.changed) c.broadcast("changed", starter.changed);
      await openCounter(c.client<AppRegistry>(), starter.key);
      return readSnapshot(c.db);
    },
    createCounter: async (c, requestId: string): Promise<SessionSnapshot> => {
      const id = sessionId(c.key);
      if (
        typeof requestId !== "string" ||
        !SESSION_ID_PATTERN.test(requestId.toLowerCase())
      ) {
        throw new UserError("A create request must have a UUID.", {
          code: "VALIDATION_FAILED",
        });
      }
      const request = requestId.toLowerCase();
      const created = await c.db.transaction(
        async (tx) => {
          const [previous] = await tx.execute<{ key: string; member: number }>(
            `SELECT key, EXISTS (SELECT 1 FROM members WHERE members.key = create_requests.key) AS member
             FROM create_requests WHERE request_id = ?`,
            request,
          );
          // A late retry must not resurrect a recently removed actor.
          if (previous && !previous.member) return null;
          const key = previous?.key ?? sessionCounterKey(id, request);
          const changed = await reserve(tx, { key });
          await tx.execute(
            "INSERT INTO create_requests (request_id, key) VALUES (?, ?) ON CONFLICT (request_id) DO NOTHING",
            request,
            key,
          );
          // Bounded retry history even when visitors repeatedly add and remove actors.
          await tx.execute(
            "DELETE FROM create_requests WHERE seq NOT IN (SELECT seq FROM create_requests ORDER BY seq DESC LIMIT ?)",
            REQUEST_HISTORY,
          );
          return { key, changed };
        },
        { name: "session-create-counter" },
      );
      if (created === null) return readSnapshot(c.db);
      if (created.changed) c.broadcast("changed", created.changed);
      await openCounter(c.client<AppRegistry>(), created.key);
      return readSnapshot(c.db);
    },
    removeCounter: async (c, key: string): Promise<SessionSnapshot> => {
      sessionId(c.key);
      if (typeof key !== "string") return readSnapshot(c.db);
      const changed = await c.db.transaction(
        async (tx) => {
          const removed = await tx.execute(
            "DELETE FROM members WHERE key = ? RETURNING key",
            key,
          );
          if (removed.length === 0) return null;
          await tx.execute("UPDATE session SET revision = revision + 1");
          return readSnapshot(tx);
        },
        { name: "session-remove-counter" },
      );
      if (!changed) return readSnapshot(c.db);
      c.broadcast("changed", changed);
      return changed;
    },
    attachCounter: async (
      c,
      key: string,
      label?: string,
    ): Promise<SessionSnapshot> => {
      sessionId(c.key);
      if (typeof key !== "string" || !COUNTER_NAME_PATTERN.test(key)) {
        throw new UserError(
          "Use a valid counter key of at most 64 characters.",
          { code: "VALIDATION_FAILED" },
        );
      }
      if (
        label !== undefined &&
        (typeof label !== "string" || !LABEL_PATTERN.test(label))
      ) {
        throw new UserError("Use a valid counter label.", {
          code: "VALIDATION_FAILED",
        });
      }
      const changed = await c.db.transaction(
        (tx) => reserve(tx, { key, label }),
        { name: "session-attach-counter" },
      );
      if (changed) c.broadcast("changed", changed);
      await openCounter(c.client<AppRegistry>(), key);
      return readSnapshot(c.db);
    },
  },
});
