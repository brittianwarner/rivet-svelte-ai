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
const client = createClient<typeof registry>({
  endpoint: process.env.RIVET_ENDPOINT || endpoint,
});
const app = createApp({
  origins: allowedOrigins(),
  endpoint: () => endpoint,
  namespace: process.env.RIVET_NAMESPACE,
  token: actorToken,
  provider: chooseProvider,
  actorHealthy: async () => (await registry.routes.health()).ok,
  ...(process.env.RIVET_ENDPOINT
    ? {
        issueBrowserToken: () =>
          client.auth.issueToken({
            expiresIn: 900,
            grants: [
              {
                resource: "actor",
                target: "any",
                operations: ["create", "read"],
              },
              {
                resource: "actor_gateway",
                target: "any",
                operations: ["create", "read"],
              },
            ],
          }),
      }
    : {}),
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

// Browser clients use the public endpoint; the runner uses the private endpoint.
registry.start();
