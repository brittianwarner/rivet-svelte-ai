import assert from "node:assert/strict";
import { test } from "node:test";
import { session } from "./actors/session.ts";
import {
  sessionCounterKey,
  type SessionActorRecord,
  type SessionSnapshot,
} from "@example/wire";

test("a failed child creation retains one reservation and the same request safely retries", async () => {
  const id = crypto.randomUUID();
  const request = crypto.randomUUID();
  const changes: SessionSnapshot[] = [];
  let attempts = 0;
  const context = {
    key: [id],
    state: {
      actors: [] as SessionActorRecord[],
      revision: 0,
      requests: {} as Record<string, string>,
      nextOrdinal: 2,
    },
    broadcast(_event: string, value: SessionSnapshot) {
      changes.push(value);
    },
    client() {
      return {
        counter: {
          getOrCreate() {
            return {
              async getCount() {
                if (++attempts === 1)
                  throw new Error("Temporary child engine failure");
                return 0;
              },
            };
          },
        },
      };
    },
  };
  const create = session.config.actions!.createCounter;
  assert.equal(typeof create, "function");
  await assert.rejects(
    create(context as unknown as Parameters<typeof create>[0], request),
    /Temporary child engine failure/,
  );
  assert.equal(context.state.actors.length, 1);
  assert.equal(context.state.revision, 1);
  assert.equal(context.state.actors[0].key, sessionCounterKey(id, request));
  const restored = await create(
    context as unknown as Parameters<typeof create>[0],
    request,
  );
  assert.equal(attempts, 2);
  assert.deepEqual(restored, { actors: context.state.actors, revision: 1 });
  assert.equal(
    changes.length,
    1,
    "retry does not rebroadcast a duplicate membership reservation",
  );
});

test("removal is idempotent, an emptied session stays empty, and retry history is bounded", async () => {
  const changes: SessionSnapshot[] = [];
  const context = {
    key: [crypto.randomUUID()],
    state: {
      actors: [] as SessionActorRecord[],
      revision: 0,
      requests: {} as Record<string, string>,
      nextOrdinal: 2,
    },
    broadcast(_event: string, value: SessionSnapshot) {
      changes.push(value);
    },
    client() {
      return {
        counter: {
          getOrCreate() {
            return {
              async getCount() {
                return 0;
              },
            };
          },
        },
      };
    },
  };
  const actions = session.config.actions!;
  const c = context as unknown as Parameters<typeof actions.ensureStarter>[0];
  await actions.ensureStarter(c);
  const starter = context.state.actors[0].key;
  actions.removeCounter(c, starter);
  const revision = context.state.revision;
  actions.removeCounter(c, starter);
  assert.equal(context.state.revision, revision, "repeated removal is a no-op");
  assert.deepEqual(
    (await actions.ensureStarter(c)).actors,
    [],
    "reload does not recreate a removed starter",
  );
  const request = crypto.randomUUID();
  await actions.createCounter(c, request);
  const created = context.state.actors[0];
  actions.removeCounter(c, created.key);
  assert.deepEqual(
    (await actions.createCounter(c, request)).actors,
    [],
    "late create retries do not resurrect removed actors",
  );
  await actions.attachCounter(c, created.key, created.label);
  assert.deepEqual(
    context.state.actors,
    [created],
    "undo restores the original key and label",
  );
  actions.removeCounter(c, created.key);
  for (let i = 0; i < 70; i++) {
    await actions.createCounter(c, crypto.randomUUID());
    actions.removeCounter(c, context.state.actors[0].key);
  }
  assert.equal(Object.keys(context.state.requests).length, 64);
  assert.deepEqual(changes.at(-1)?.actors, []);
});
