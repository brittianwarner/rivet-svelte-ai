import assert from "node:assert/strict";
import { createClient } from "rivetkit/client";
import type { registry } from "../src/actors.ts";
import type { ChatResponseEvent, ClientConfig } from "@example/wire";

const origin = process.env.SMOKE_API_ORIGIN || "http://127.0.0.1:3002";
const local = (url: string) =>
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
assert.ok(local(origin), "Chat acceptance only targets a local test API.");
const config = (await (
  await fetch(`${origin}/client-config`)
).json()) as ClientConfig;
assert.ok(
  local(config.rivetEndpoint),
  "Chat acceptance only creates actors on a local engine.",
);
const client = createClient<typeof registry>(config.rivetEndpoint);
const timeout = setTimeout(() => {
  console.error("Chat integration timed out");
  process.exit(1);
}, 40_000);
async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Chat state did not settle.");
}
try {
  const key = `chat-example-${crypto.randomUUID()}`;
  const handle = client.chat.getOrCreate(["chat", key]);
  const connection = handle.connect();
  const events: ChatResponseEvent[] = [];
  connection.on("response", (event) => events.push(event));
  await connection.getSnapshot();
  await connection.sendMessage("Say hello");
  const finished = await until(
    () => connection.getSnapshot(),
    (snapshot) =>
      snapshot.status.state === "idle" && snapshot.messages.length === 2,
  );
  assert.equal(finished.messages[1].content, "Hello from the local model.");
  assert.ok(
    events.some((event) => !event.done && event.content.length > 0),
    "Partial replies must reach a real socket subscriber.",
  );
  assert.ok(
    events.some((event) => event.done),
    "Completion must reach subscribers.",
  );
  await connection.dispose();
  assert.deepEqual(await handle.getSnapshot(), finished);
  const isolated = client.chat.getOrCreate([
    "chat",
    `isolated-${crypto.randomUUID()}`,
  ]);
  assert.equal((await isolated.getSnapshot()).messages.length, 0);
  console.log(
    "Chat streaming, socket events, reconnect snapshot, and isolation passed.",
  );

  await handle.sendMessage("[slow]");
  await until(
    () => handle.getSnapshot(),
    (snapshot) =>
      snapshot.messages.at(-1)?.content.startsWith("Partial reply") === true,
  );
  await handle.cancel();
  const stopped = await until(
    () => handle.getSnapshot(),
    (snapshot) => snapshot.status.state === "idle",
  );
  assert.match(stopped.messages.at(-1)!.content, /^Partial reply/);
  await handle.sendMessage("[fail]");
  const failed = await until(
    () => handle.getSnapshot(),
    (snapshot) => snapshot.status.state === "error",
  );
  assert.match(failed.status.error || "", /model request failed/);
  await handle.sendMessage("Try again");
  const recovered = await until(
    () => handle.getSnapshot(),
    (snapshot) => snapshot.status.state === "idle",
  );
  assert.equal(
    recovered.messages.at(-1)!.content,
    "Hello from the local model.",
  );
  console.log("Chat partial cancellation, provider failure, and retry passed.");

  await handle.sendMessage("[wait]");
  await until(
    () => handle.getStatus(),
    (status) => status.state === "thinking",
  );
  await handle.cancel();
  const early = await until(
    () => handle.getSnapshot(),
    (snapshot) => snapshot.status.state === "idle",
  );
  assert.equal(early.messages.at(-1)!.content, "");
  console.log("Chat cancellation before the first token passed.");
} finally {
  clearTimeout(timeout);
  await client.dispose();
}
