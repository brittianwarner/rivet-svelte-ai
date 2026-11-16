/**
 * The chat and session actors through the public edge, with the local model
 * fixture preloaded into the server. No paid model requests.
 * Run with `bun run test:integration` (turbo runs it in apps/server).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";

const here = new URL(".", import.meta.url).pathname;
const fixture = new URL("../../../tests/fixtures/provider.mjs", import.meta.url)
  .pathname;

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    enginePort: 6580,
    port: 3030,
    preload: fixture,
    env: { OPENROUTER_API_KEY: "local-test-key" },
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
}, 60_000);

async function run(script: string): Promise<void> {
  const child = Bun.spawn([process.execPath, script], {
    cwd: here,
    env: { ...process.env, SMOKE_API_ORIGIN: h.origin },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    console.error(
      `${script}\n${out}\n${err.split("\n").slice(-20).join("\n")}`,
    );
  expect(code).toBe(0);
}

test(
  "chat: streaming, reconnect, cancellation, provider failure, retry",
  () => run("chat-integration.ts"),
  90_000,
);

test(
  "sessions: idempotency, isolation, bounded admission, reconnect",
  () => run("session-integration.ts"),
  90_000,
);
