import { actor, event, UserError } from "rivetkit";
import { authorizeConnection } from "../auth.ts";

export const counter = actor({
  state: { count: 0 },
  events: { newCount: event<number>() },
  onBeforeConnect: (c, params) => {
    authorizeConnection(c, params);
  },
  actions: {
    getCount: (c) => c.state.count,
    increment: (c, by: number) => {
      if (!Number.isInteger(by) || by < 1 || by > 100) {
        throw new UserError("Increment must be a whole number from 1 to 100.", {
          code: "VALIDATION_FAILED",
        });
      }
      if (!Number.isSafeInteger(c.state.count + by)) {
        throw new UserError("Counter limit reached.", {
          code: "COUNTER_LIMIT",
        });
      }
      c.state.count += by;
      c.broadcast("newCount", c.state.count);
      return c.state.count;
    },
  },
});
