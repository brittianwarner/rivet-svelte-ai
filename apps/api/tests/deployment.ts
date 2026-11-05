import assert from "node:assert/strict";
import { createClient } from "rivetkit/client";
import type { registry } from "../src/actors.ts";
import type { ClientConfig } from "@example/wire";

// An explicit URL is required: this test writes only to its own acceptance actor.
const origin = process.argv[2];
if (!origin)
  throw new Error("Usage: bun run test:deployment https://your-web-domain");
const base = new URL(origin);
if (
  base.pathname !== "/" ||
  base.search ||
  base.hash ||
  base.username ||
  base.password
)
  throw new Error("Pass only the web origin, without a path or credentials.");
const configResponse = await fetch(new URL("/api/client-config", base));
assert.ok(configResponse.ok, "Web-to-API proxy must work");
const config = (await configResponse.json()) as ClientConfig;
assert.equal(
  new URL(config.rivetEndpoint).password,
  "",
  "No admin credential in browser config",
);
assert.ok(
  config.authenticatedEngine,
  "Hosted engine must use scoped browser credentials",
);
let scopedToken = "";
const client = createClient<typeof registry>({
  endpoint: config.rivetEndpoint,
  namespace: config.rivetNamespace,
  getToken: async () => {
    const response = await fetch(new URL("/api/client-token", base), {
      method: "POST",
      headers: { origin: base.origin, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    assert.ok(response.ok, "Scoped token issuance must work");
    scopedToken = (await response.json()).token;
    return scopedToken;
  },
});
const timeout = setTimeout(() => {
  console.error("Deployment acceptance timed out");
  process.exit(1);
}, 60_000);
const key = process.env.SMOKE_ACTOR_KEY || `acceptance-${crypto.randomUUID()}`;
const counter = client.counter.getOrCreate(["counter", key], {
  params: config.actorToken ? { token: config.actorToken } : {},
});
try {
  const before = await counter.getCount();
  if (process.env.SMOKE_EXPECT_COUNT !== undefined)
    assert.equal(
      before,
      Number(process.env.SMOKE_EXPECT_COUNT),
      "Count must survive restart",
    );
  const connection = counter.connect();
  let eventCount: number | undefined;
  connection.on("newCount", (count) => {
    eventCount = count;
  });
  await connection.getCount();
  assert.equal(await counter.increment(1), before + 1);
  for (let i = 0; i < 100 && eventCount !== before + 1; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(eventCount, before + 1, "WebSocket must deliver the update");
  const http = await fetch(new URL(`/api/counters/${key}/increment`, base), {
    method: "POST",
    headers: { "content-type": "application/json", origin: base.origin },
    body: JSON.stringify({ by: 2 }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(http.status, 200);
  assert.equal((await http.json()).count, before + 3);
  assert.equal(await counter.getCount(), before + 3);
  const admin = new URL(
    "/pools/default/nodes?namespace=default",
    config.rivetEndpoint,
  );
  admin.searchParams.set("namespace", config.rivetNamespace || "default");
  const denied = await fetch(admin, {
    headers: { Authorization: `Bearer ${scopedToken}` },
  });
  assert.ok(
    [401, 403].includes(denied.status),
    "Browser token must not access node administration",
  );
  console.log(
    JSON.stringify({
      ok: true,
      actorKey: key,
      count: before + 3,
      checks: [
        "proxy",
        "scoped-token",
        "action",
        "websocket-event",
        "http-action",
        "admin-denied",
      ],
    }),
  );
} finally {
  clearTimeout(timeout);
  await client.dispose();
}
