import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIsolatedEngine } from "./engine.ts";

const directory = await mkdtemp(join(tmpdir(), "rivet-browser-engine-"));
const port = Number(process.env.E2E_ENGINE_PORT || 6540);
const engine = await startIsolatedEngine(directory, port);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await engine.stop();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
engine.child.on("exit", () => {
  if (!stopping) process.exit(1);
});
console.log(`Isolated Rivet browser-test engine listening on port ${port}.`);
