import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({
  API_ORIGIN: {
    description: "Private URL used by SvelteKit to reach the API service.",
    schema: (value) => {
      const url = new URL(value || "http://127.0.0.1:3001");
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("API_ORIGIN must use HTTP or HTTPS.");
      }
      return url.origin;
    },
  },
});
