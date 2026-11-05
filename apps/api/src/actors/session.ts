import { actor, event, UserError } from "rivetkit";
import {
  COUNTER_NAME_PATTERN,
  SESSION_ACTOR_LIMIT,
  SESSION_ID_PATTERN,
  sessionCounterKey,
  type SessionActorRecord,
  type SessionSnapshot,
} from "@example/wire";
import type { registry } from "../actors.ts";
import { authorizeConnection, serverActorParams } from "../auth.ts";

interface SessionState {
  actors: SessionActorRecord[];
  revision: number;
  requests: Record<string, string>;
  nextOrdinal: number;
}
interface MembershipContext {
  state: SessionState;
  broadcast: (name: "changed", snapshot: SessionSnapshot) => void;
}

function sessionId(key: string[]): string {
  if (key.length !== 1 || !SESSION_ID_PATTERN.test(key[0])) {
    throw new UserError("A session key must be one canonical UUID.", {
      code: "VALIDATION_FAILED",
    });
  }
  return key[0];
}
function snapshot(state: SessionState): SessionSnapshot {
  return {
    actors: state.actors.map(({ key, label }) => ({ key, label })),
    revision: state.revision,
  };
}
/** Reserve synchronously before contacting another actor, so concurrent calls see the cap. */
function reserve(c: MembershipContext, key: string, label?: string): void {
  if (c.state.actors.some((record) => record.key === key)) return;
  if (c.state.actors.length >= SESSION_ACTOR_LIMIT) {
    throw new UserError("This session already has seven actors.", {
      code: "SESSION_FULL",
    });
  }
  const name =
    label ?? `counter-${String(c.state.nextOrdinal++).padStart(2, "0")}`;
  c.state.actors.push({ key, label: name });
  c.state.revision += 1;
  c.broadcast("changed", snapshot(c.state));
}

/** One persistent membership registry per visitor UUID; counters own their own state. */
export const session = actor({
  state: {
    actors: [] as SessionActorRecord[],
    revision: 0,
    requests: {} as Record<string, string>,
    nextOrdinal: 2,
  } satisfies SessionState,
  events: { changed: event<SessionSnapshot>() },
  onBeforeConnect: (c, params) => {
    authorizeConnection(c, params);
    sessionId(c.key);
  },
  actions: {
    getSnapshot: (c): SessionSnapshot => {
      sessionId(c.key);
      return snapshot(c.state);
    },
    ensureStarter: async (c): Promise<SessionSnapshot> => {
      const id = sessionId(c.key);
      // An intentionally emptied session must stay empty on reload.
      if (c.state.actors.length === 0 && c.state.revision > 0)
        return snapshot(c.state);
      const key = c.state.actors[0]?.key ?? `session-${id}-01`;
      if (c.state.actors.length === 0) reserve(c, key, "counter-01");
      // Membership remains reserved if the engine is temporarily unavailable;
      // retrying this action retries the same child rather than allocating another.
      await c
        .client<typeof registry>()
        .counter.getOrCreate(["counter", key], {
          params: serverActorParams(),
        })
        .getCount();
      return snapshot(c.state);
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
      const previous = c.state.requests[request];
      // A late retry must not resurrect a recently removed actor.
      if (previous && !c.state.actors.some((record) => record.key === previous))
        return snapshot(c.state);
      const key = previous ?? sessionCounterKey(id, request);
      reserve(c, key);
      c.state.requests[request] = key;
      // Bounded retry history even when visitors repeatedly add and remove actors.
      for (const oldest of Object.keys(c.state.requests).slice(0, -64))
        delete c.state.requests[oldest];
      await c
        .client<typeof registry>()
        .counter.getOrCreate(["counter", key], {
          params: serverActorParams(),
        })
        .getCount();
      return snapshot(c.state);
    },
    removeCounter: (c, key: string): SessionSnapshot => {
      sessionId(c.key);
      const index = c.state.actors.findIndex((record) => record.key === key);
      if (index !== -1) {
        c.state.actors.splice(index, 1);
        c.state.revision += 1;
        c.broadcast("changed", snapshot(c.state));
      }
      return snapshot(c.state);
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
        (typeof label !== "string" || !/^counter-[0-9]{2,10}$/.test(label))
      ) {
        throw new UserError("Use a valid counter label.", {
          code: "VALIDATION_FAILED",
        });
      }
      reserve(c, key, label);
      await c
        .client<typeof registry>()
        .counter.getOrCreate(["counter", key], {
          params: serverActorParams(),
        })
        .getCount();
      return snapshot(c.state);
    },
  },
});
