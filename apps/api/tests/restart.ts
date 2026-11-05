import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { startIsolatedEngine, stopProcess, pause } from "./engine.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "rivetkit/client";
import type { registry } from "../src/actors.ts";

// Dedicated data directory and ports: never open the developer's local database.
const directory = await mkdtemp(join(tmpdir(), "rivet-restart-"));
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
let child: ChildProcess | undefined;
let engine: ChildProcess | undefined;
let client: ReturnType<typeof createClient<typeof registry>> | undefined;
let logs = "";
async function start() {
  child = spawn(process.execPath, [entry], {
    cwd: directory,
    env: {
      ...process.env,
      API_PORT: "3003",
      API_HOST: "127.0.0.1",
      RIVET_ENDPOINT: "http://127.0.0.1:6550",
      RIVET_TOKEN: "default",
      RIVET_NAMESPACE: "default",
      RIVET_PUBLIC_ENDPOINT: "http://127.0.0.1:6550",
      RIVET_RUN_ENGINE_PORT: "6550",
      ACTOR_TOKEN: "",
      OPENROUTER_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (data) => {
    logs = (logs + data).slice(-5000);
  });
  child.stderr?.on("data", (data) => {
    logs = (logs + data).slice(-5000);
  });
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `API exited (${child.exitCode ?? child.signalCode}): ${logs}`,
      );
    try {
      const response = await fetch("http://127.0.0.1:3003/health", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const engine = await fetch("http://127.0.0.1:6550/", {
          signal: AbortSignal.timeout(1000),
        });
        if (engine.status < 500) return;
      }
    } catch {}
    await pause(100);
  }
  throw new Error(`API startup timed out: ${logs}`);
}
async function stop() {
  await client?.dispose();
  client = undefined;
  await stopProcess(child);
}
const timeout = setTimeout(() => {
  console.error(logs);
  void (async () => {
    await stop();
    await stopProcess(engine);
    await rm(directory, { recursive: true, force: true });
    process.exit(1);
  })();
}, 90_000);
try {
  engine = (await startIsolatedEngine(directory, 6550)).child;
  await start();
  client = createClient<typeof registry>("http://127.0.0.1:6550");
  const key = `restart-${crypto.randomUUID()}`;
  const counter = client.counter.getOrCreate(["counter", key]);
  assert.equal(await counter.increment(7), 7);
  const chat = client.chat.getOrCreate(["chat", key]);
  await chat.sendMessage("Persist this conversation");
  for (let i = 0; i < 100; i++) {
    if ((await chat.getStatus()).state === "error") break;
    await pause(50);
  }
  const snapshot = await chat.getSnapshot();
  assert.equal(snapshot.status.state, "error");
  assert.equal(snapshot.messages.length, 2);
  // Permit Rivet's asynchronous state checkpoint before terminating the process.
  await pause(6000);
  await stop();
  if (process.env.FULL_ENGINE_RESTART === "1") {
    await stopProcess(engine);
    engine = (await startIsolatedEngine(directory, 6550)).child;
  }
  await start();
  client = createClient<typeof registry>("http://127.0.0.1:6550");
  assert.equal(
    await client.counter.getOrCreate(["counter", key]).getCount(),
    7,
  );
  assert.deepEqual(
    await client.chat.getOrCreate(["chat", key]).getSnapshot(),
    snapshot,
  );
  console.log(
    process.env.FULL_ENGINE_RESTART === "1"
      ? "Checkpointed state restored after API and engine restart."
      : "Checkpointed counter and chat state restored after API/runner restart (engine stayed running).",
  );
} finally {
  clearTimeout(timeout);
  await stop();
  await stopProcess(engine);
  await rm(directory, { recursive: true, force: true });
}
