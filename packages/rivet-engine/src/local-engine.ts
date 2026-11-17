/**
 * A single-node engine on this machine, with its data in a directory instead
 * of a bucket. Development, tests, and ROLE=all without S3 use it.
 *
 * Why not RivetKit's built-in launcher: it keeps every project's data in one
 * shared directory (~/.rivetkit/var/engine), so a second project's engine on
 * the same machine fails to take the lock and the registry times out after a
 * minute. Here each checkout (or test) owns its own directory, and the engine
 * outlives API restarts: `bun run dev` keeps it running while the API reloads.
 */
import type { Subprocess } from "bun";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@example/config";
import type { EngineHandle } from "./engine-process.ts";

export interface LocalEngineOptions {
  /** Data directory. Created if missing; one engine per directory. */
  dir: string;
  /** Guard port. api_peer and metrics use the next two. */
  port: number;
  adminToken: string;
  /** Engine binary. Default: RIVET_ENGINE_BIN, else @rivetkit/engine-cli. */
  binary?: string;
  /** Where the engine writes its output. Default: `<dir>/engine.log`. */
  logFile?: string;
  /** Extra RIVET__* settings. */
  env?: Record<string, string>;
}

async function engineBinary(explicit?: string): Promise<string> {
  const fromEnv = explicit ?? process.env.RIVET_ENGINE_BIN?.trim();
  if (fromEnv) return fromEnv;
  const { getEnginePath } = (await import("@rivetkit/engine-cli")) as {
    getEnginePath(): string;
  };
  return getEnginePath();
}

/** The settings RivetKit's own launcher uses for a one-node engine. */
export function localEngineEnv(opts: {
  dir: string;
  port: number;
  adminToken: string;
}): Record<string, string> {
  return {
    RIVET__AUTH__ADMIN_TOKEN: opts.adminToken,
    RIVET__GUARD__HOST: "127.0.0.1",
    RIVET__GUARD__PORT: String(opts.port),
    RIVET__API_PEER__HOST: "127.0.0.1",
    RIVET__API_PEER__PORT: String(opts.port + 1),
    RIVET__METRICS__HOST: "127.0.0.1",
    RIVET__METRICS__PORT: String(opts.port + 2),
    RIVET__STORAGE__LOG_DIRECTORY: join(opts.dir, "log"),
    RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(
      opts.dir,
      "objects",
    ),
    RIVET__STORAGE__BALANCING__ENABLED: "false",
    RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1",
    RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0",
    RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(4 * 1024 ** 3),
    RIVET__STORAGE__WRITE_TO_COLD_AFTER_MS: "5000",
    RIVET__STORAGE__STOP_TIMEOUT_MS: "6000",
    RIVET__STORAGE__STOP_TEARDOWN_MS: "2000",
    RIVET__PEGBOARD__NODE_LOST_THRESHOLD: "7000",
    RIVET__RUNTIME__WORKER_SHUTDOWN_DURATION: "1",
    RIVET__RUNTIME__GUARD_SHUTDOWN_DURATION: "1",
    RIVET__RUNTIME__FORCE_SHUTDOWN_DURATION: "10",
    RIVET__TELEMETRY__ENABLED: "false",
  };
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function tail(path: string, bytes = 2000): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "";
  const size = file.size;
  return (await file.slice(Math.max(0, size - bytes), size).text()).trim();
}

export async function startLocalEngine(
  opts: LocalEngineOptions,
): Promise<EngineHandle> {
  const endpoint = `http://127.0.0.1:${opts.port}`;
  if (await answers(endpoint)) {
    throw new Error(
      `Port ${opts.port} is already in use (another engine?). Stop it, or set ENGINE_PORT to a free port.`,
    );
  }

  await mkdir(join(opts.dir, "log"), { recursive: true });
  await mkdir(join(opts.dir, "objects"), { recursive: true });
  const configPath = join(opts.dir, "config.json");
  await Bun.write(
    configPath,
    JSON.stringify({
      topology: {
        datacenter_label: 1,
        datacenters: {
          default: {
            datacenter_label: 1,
            is_leader: true,
            peer_url: `http://127.0.0.1:${opts.port + 1}`,
            public_url: `${endpoint}/`,
          },
        },
      },
    }),
  );

  const logFile = opts.logFile ?? join(opts.dir, "engine.log");
  const output = await open(logFile, "a");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // The engine never sees app secrets.
    if (value === undefined || key.startsWith("RIVET__")) continue;
    if (/(SECRET|TOKEN|KEY|PASSWORD)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(
    env,
    localEngineEnv({
      dir: opts.dir,
      port: opts.port,
      adminToken: opts.adminToken,
    }),
    opts.env,
  );

  const child: Subprocess = Bun.spawn(
    [await engineBinary(opts.binary), "--config", configPath],
    {
      cwd: opts.dir,
      env,
      stdin: "ignore",
      stdout: output.fd,
      stderr: output.fd,
    },
  );
  const exited = child.exited.then(async (code) => {
    await output.close().catch(() => {});
    return code ?? 1;
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    const done = await Promise.race([
      exited.then(() => true),
      Bun.sleep(100).then(() => false),
    ]);
    if (done) {
      const reason = await tail(logFile);
      throw new Error(
        `The local engine exited during startup.${
          /already in use by another engine/.test(reason)
            ? ` Another engine is using ${opts.dir}; stop it or set ENGINE_DATA_DIR.`
            : ""
        }\n${reason}`,
      );
    }
    try {
      const response = await fetch(`${endpoint}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(
        `The local engine did not become healthy.\n${await tail(logFile)}`,
      );
    }
  }
  log.info("local engine ready", { endpoint, dir: opts.dir });

  let stopping: Promise<void> | null = null;
  return {
    endpoint,
    exited,
    stop() {
      stopping ??= (async () => {
        if (child.exitCode !== null) return;
        child.kill("SIGTERM");
        const finished = await Promise.race([
          exited.then(() => true),
          Bun.sleep(15_000).then(() => false),
        ]);
        if (!finished) {
          child.kill("SIGKILL");
          await exited;
        }
      })();
      return stopping;
    },
  };
}
