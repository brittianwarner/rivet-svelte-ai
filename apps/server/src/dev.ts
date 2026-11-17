/**
 * `bun run dev` for the server: the same three services as production, on
 * one machine.
 *
 *   engine  a local node on ENGINE_PORT (6440), data in .rivet/engine.
 *           Started once; it keeps running while the API reloads, so actor
 *           state survives every save.
 *   api     ROLE=api on PORT (3001): actors, /api, /rivet. A save in
 *           apps/server or any server package stops it cleanly and starts it
 *           again, in about a second. (Not `bun --watch`: its restart does not
 *           wait for the runner to drain, and the next start then stalls.)
 *   web     Vite on WEB_PORT (5173, apps/web), forwarding /api and /rivet here the way
 *           the web service forwards to the api in production.
 *
 * With RIVET_ENDPOINT set (an engine elsewhere), only the API runs.
 */
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LOCAL_ENGINE_TOKEN,
  engineDataDir,
  enginePort,
  loadRootEnv,
  log,
  portFromEnv,
  webPort,
} from "@example/config";
import { startLocalEngine, type EngineHandle } from "@example/rivet-engine";

loadRootEnv();

const external = process.env.RIVET_ENDPOINT?.trim();
let engine: EngineHandle | null = null;
if (!external) {
  try {
    engine = await startLocalEngine({
      dir: engineDataDir(),
      port: enginePort(),
      adminToken: LOCAL_ENGINE_TOKEN,
    });
  } catch (error) {
    log.error("dev: the local engine did not start", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

const apiPort = portFromEnv(process.env.PORT ?? process.env.API_PORT, 3001);
const serverDir = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));
/** Source the API runs. The web app reloads itself through Vite. */
const WATCHED = [
  "apps/server/src",
  "packages/actors/src",
  "packages/api/src",
  "packages/config/src",
  "packages/entities/src",
  "packages/files/src",
  "packages/rivet-edge/src",
  "packages/rivet-engine/src",
  "packages/wire/src",
];

let api: ReturnType<typeof Bun.spawn> | null = null;
let stopping = false;

function startApi(): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn([process.execPath, "src/main.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      ROLE: "api",
      PORT: String(apiPort),
      RIVET_ENDPOINT: external || engine!.endpoint,
      RIVET_TOKEN: external ? process.env.RIVET_TOKEN : LOCAL_ENGINE_TOKEN,
    },
    stdio: ["inherit", "inherit", "inherit"],
  });
  void child.exited.then((code) => {
    // A crash waits for the next save; a clean stop is ours.
    if (!stopping && api === child && code !== 0)
      log.warn("dev: the API exited; save a file to restart it", { code });
  });
  return child;
}

async function stopApi(): Promise<void> {
  const child = api;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([child.exited, Bun.sleep(8_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

async function waitReady(): Promise<boolean> {
  for (let i = 0; i < 600 && !stopping; i++) {
    try {
      const ready = await fetch(
        `http://127.0.0.1:${apiPort}/api/health/actors`,
        {
          signal: AbortSignal.timeout(500),
        },
      );
      if (ready.ok) return true;
    } catch {
      // Still booting.
    }
    if (api?.exitCode !== null) return false;
    await Bun.sleep(50);
  }
  return false;
}

// Restarts are serialized: changes during a restart coalesce into one more.
let restarting: Promise<void> | null = null;
let again = false;
let changed = "";
async function restart(): Promise<void> {
  if (restarting) {
    again = true;
    return;
  }
  restarting = (async () => {
    do {
      again = false;
      const started = performance.now();
      const file = changed;
      await stopApi();
      api = startApi();
      if (await waitReady())
        log.info("dev: reloaded", {
          file,
          ms: Math.round(performance.now() - started),
        });
    } while (again && !stopping);
  })();
  await restarting;
  restarting = null;
}

let timer: ReturnType<typeof setTimeout> | null = null;
for (const dir of WATCHED) {
  watch(`${root}/${dir}`, { recursive: true }, (_event, name) => {
    if (!name || stopping) return;
    const file = String(name);
    if (!/\.(ts|js|json)$/.test(file) || /\.test\.ts$/.test(file)) return;
    changed = `${dir}/${file}`;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void restart(), 60);
  });
}

async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    await stopApi();
    await engine?.stop();
  }
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void stop(0));

api = startApi();
if (await waitReady()) {
  log.info("dev ready", {
    web: `http://localhost:${webPort()}`,
    api: `http://127.0.0.1:${apiPort}`,
    engine: external || engine!.endpoint,
    ...(engine ? { data: engineDataDir() } : {}),
  });
}
