import { serve } from "@hono/node-server";
import { createClient } from "rivetkit/client";
import { registry } from "./actors.ts";
import { createApp } from "./app.ts";
import { serverActorParams } from "./auth.ts";
import {
  actorToken,
  allowedOrigins,
  loadRootEnv,
  publicEndpoint,
  portFromEnv,
} from "./env.ts";
import { chooseProvider } from "./model.ts";

loadRootEnv();
const endpoint = publicEndpoint();
const client = createClient<typeof registry>(endpoint);
const app = createApp({
  origins: allowedOrigins(),
  endpoint: () => endpoint,
  token: actorToken,
  provider: chooseProvider,
  increment: (name, by) =>
    client.counter
      .getOrCreate(["counter", name], {
        params: serverActorParams(),
      })
      .increment(by),
});

const port = portFromEnv(process.env.API_PORT ?? process.env.PORT, 3001);

serve(
  { fetch: app.fetch, port, hostname: process.env.API_HOST || "127.0.0.1" },
  (info) => {
    const choice = chooseProvider();
    console.log(
      `api http://127.0.0.1:${info.port} provider=${choice.provider} model=${choice.modelId ?? "none"}`,
    );
  },
);

// Local file engine + in-process runner. Browser clients use RIVET_PUBLIC_ENDPOINT.
registry.start();
