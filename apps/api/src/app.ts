import { COUNTER_NAME_PATTERN } from "@example/wire";
import type { ProviderChoice } from "./model.ts";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";

interface ApiDependencies {
  origins: string[];
  endpoint: () => string;
  token: () => string | null;
  provider: () => ProviderChoice;
  increment: (name: string, by: number) => Promise<number>;
}

/** HTTP boundary, independently testable without booting an actor engine. */
export function createApp(deps: ApiDependencies) {
  const app = new Hono();
  const WEB_ORIGINS = deps.origins;

  app.use("*", async (c, next) => {
    return cors({ origin: WEB_ORIGINS })(c, next);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/ready", (c) => {
    const choice = deps.provider();
    return c.json({
      provider: choice.provider,
      model: choice.modelId,
    });
  });

  app.get("/client-config", (c) =>
    c.json({
      rivetEndpoint: deps.endpoint(),
      actorToken: deps.token(),
    }),
  );

  app.post(
    "/counters/:name/increment",
    bodyLimit({ maxSize: 1024 }),
    async (c) => {
      const origin = c.req.header("origin");
      if (origin && !WEB_ORIGINS.includes(origin))
        return c.json({ error: "origin_not_allowed" }, 403);
      const name = c.req.param("name");
      if (!COUNTER_NAME_PATTERN.test(name)) {
        return c.json({ error: "invalid_name" }, 400);
      }

      let by = 1;
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return c.json({ error: "invalid_body" }, 400);
      if (body && typeof body === "object" && "by" in body) {
        const requested = (body as { by?: unknown }).by;
        if (
          typeof requested !== "number" ||
          !Number.isInteger(requested) ||
          requested < 1 ||
          requested > 100
        ) {
          return c.json({ error: "invalid_by" }, 400);
        }
        by = requested;
      }

      try {
        const count = await deps.increment(name, by);
        return c.json({ count });
      } catch (error) {
        console.error("Counter action failed", error);
        return c.json({ error: "Actor unavailable. Please retry." }, 502);
      }
    },
  );

  return app;
}
