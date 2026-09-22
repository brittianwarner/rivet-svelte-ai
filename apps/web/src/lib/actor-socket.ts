import { getActorToken } from "./rivet.js";

/** Fresh connection params and action defaults shared by every view model. */
export function actorSocketOptions(): {
  getParams: () => Promise<{ token?: string }>;
  actionDefaults: { throwOnError: false; timeout: number };
} {
  return {
    getParams: async () => {
      const token = getActorToken();
      return token ? { token } : {};
    },
    actionDefaults: {
      throwOnError: false,
      timeout: 15_000,
    },
  };
}
