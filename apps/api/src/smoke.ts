import assert from "node:assert/strict";
import { createClient } from "rivetkit/client";
import type { registry } from "./actors.ts";
import type { ClientConfig } from "@example/wire";

const origin = process.env.SMOKE_API_ORIGIN || "http://127.0.0.1:3001";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
  throw new Error("This mutating smoke test is for a local API only.");
}
const configResponse = await fetch(`${origin}/client-config`, {
  signal: AbortSignal.timeout(10_000),
});
assert.ok(configResponse.ok, "API client configuration must be available");
const config = (await configResponse.json()) as ClientConfig;
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(config.rivetEndpoint).hostname,
  )
) {
  throw new Error("This smoke test will not create actors on a remote engine.");
}
const client = createClient<typeof registry>(config.rivetEndpoint);
const timeout = setTimeout(() => {
  console.error("Actor smoke test timed out.");
  process.exit(1);
}, 30_000);
const key = `smoke-${crypto.randomUUID()}`;
const options = {
  params: config.actorToken ? { token: config.actorToken } : {},
};
try {
  const counter = client.counter.getOrCreate(["counter", key], options);
  assert.equal(await counter.increment(1), 1);
  const response = await fetch(`${origin}/counters/${key}/increment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ by: 2 }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { count: 3 });
  assert.equal(await counter.getCount(), 3);
  await assert.rejects(counter.increment(0));
  const provider = (await (await fetch(`${origin}/ready`)).json()) as {
    provider: string;
  };
  if (provider.provider === "none") {
    const chat = client.chat.getOrCreate(["chat", key], options);
    await assert.rejects(chat.sendMessage("   "));
    await assert.rejects(chat.sendMessage("x".repeat(8001)));
    await assert.rejects(chat.send("message", { text: "Bypass admission" }));
    await chat.sendMessage("A local smoke test with no provider.");
    let snapshot = await chat.getSnapshot();
    while (snapshot.status.state !== "error") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      snapshot = await chat.getSnapshot();
    }
    assert.equal(snapshot.messages.length, 2);
    assert.match(snapshot.messages[1].content, /OPENROUTER_API_KEY/);
    assert.match(snapshot.status.error ?? "", /OPENROUTER_API_KEY/);
    console.log(
      "Chat validation, private queue, and missing-provider settlement passed.",
    );
  }
  console.log(
    "Local actor creation, typed actions, HTTP updates, and validation passed.",
  );
} finally {
  clearTimeout(timeout);
  await client.dispose();
}
