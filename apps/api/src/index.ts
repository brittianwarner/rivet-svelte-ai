import { COUNTER_NAME_PATTERN } from "@example/wire";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { createClient } from "rivetkit/client";
import { registry } from "./actors.ts";
import { serverActorParams } from "./auth.ts";
import { actorToken, loadRootEnv, publicEndpoint } from "./env.ts";
import { chooseProvider } from "./model.ts";

loadRootEnv();

const WEB_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

let serverClient: ReturnType<typeof createClient<typeof registry>> | null = null;

function getServerClient(): ReturnType<typeof createClient<typeof registry>> {
  serverClient ??= createClient<typeof registry>(publicEndpoint());
  return serverClient;
}

const app = new Hono();

app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/rivet")) return next();
  return cors({ origin: WEB_ORIGINS })(c, next);
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/ready", (c) => {
  const choice = chooseProvider();
  return c.json({
    provider: choice.provider,
    model: choice.modelId,
  });
});

app.get("/client-config", (c) =>
  c.json({
    rivetEndpoint: publicEndpoint(),
    actorToken: actorToken(),
  }),
);

app.post("/counters/:name/increment", async (c) => {
  const name = c.req.param("name");
  if (!COUNTER_NAME_PATTERN.test(name)) {
    return c.json({ error: "invalid_name" }, 400);
  }

  let by = 1;
  const body = await c.req.json().catch(() => ({}));
  if (body && typeof body === "object" && "by" in body) {
    const requested = (body as { by?: unknown }).by;
    if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1 || requested > 100) {
      return c.json({ error: "invalid_by" }, 400);
    }
    by = requested;
  }

  try {
    const handle = getServerClient().counter.getOrCreate(["counter", name], {
      params: serverActorParams(),
    });
    const count = await handle.increment(by);
    return c.json({ count });
  } catch (error) {
    const message = error instanceof Error ? error.message : "actor_call_failed";
    return c.json({ error: message }, 502);
  }
});

// Serverless / engine callback path from the Rivet HTTP server docs.
app.all("/api/rivet/*", (c) => registry.handler(c.req.raw));

const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, (info) => {
  const choice = chooseProvider();
  console.log(
    `api http://127.0.0.1:${info.port} provider=${choice.provider} model=${choice.modelId ?? "none"}`,
  );
});

// Local file engine + in-process runner. Browser clients use RIVET_PUBLIC_ENDPOINT.
registry.start();
