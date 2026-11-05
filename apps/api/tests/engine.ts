import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

export const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function stopProcess(
  child: ChildProcess | undefined,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.kill("SIGTERM");
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

/** Launch directly: Rivet's automatic engine launcher uses a global runtime stamp. */
export async function startIsolatedEngine(directory: string, port: number) {
  const require = createRequire(import.meta.url);
  const rivetRequire = createRequire(require.resolve("rivetkit"));
  const { getEnginePath } = await import(
    rivetRequire.resolve("@rivetkit/engine-cli")
  );
  await mkdir(join(directory, "log"), { recursive: true });
  await mkdir(join(directory, "objects"), { recursive: true });
  const configPath = join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      topology: {
        datacenter_label: 1,
        datacenters: {
          default: {
            datacenter_label: 1,
            is_leader: true,
            peer_url: `http://127.0.0.1:${port + 1}`,
            public_url: `http://127.0.0.1:${port}/`,
          },
        },
      },
    }),
  );
  const child = spawn(getEnginePath(), ["--config", configPath], {
    cwd: directory,
    env: {
      ...process.env,
      RIVET__AUTH__ADMIN_TOKEN: "default",
      RIVET__GUARD__HOST: "127.0.0.1",
      RIVET__GUARD__PORT: String(port),
      RIVET__API_PEER__HOST: "127.0.0.1",
      RIVET__API_PEER__PORT: String(port + 1),
      RIVET__METRICS__HOST: "127.0.0.1",
      RIVET__METRICS__PORT: String(port + 2),
      RIVET__STORAGE__LOG_DIRECTORY: join(directory, "log"),
      RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(
        directory,
        "objects",
      ),
      RIVET__STORAGE__BALANCING__ENABLED: "false",
      RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1",
      RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0",
      RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: "4294967296",
      RIVET__STORAGE__WRITE_TO_COLD_AFTER_MS: "5000",
      RIVET__STORAGE__STOP_TIMEOUT_MS: "6000",
      RIVET__STORAGE__STOP_TEARDOWN_MS: "2000",
      RIVET__PEGBOARD__NODE_LOST_THRESHOLD: "7000",
      RIVET__RUNTIME__WORKER_SHUTDOWN_DURATION: "1",
      RIVET__RUNTIME__GUARD_SHUTDOWN_DURATION: "1",
      RIVET__RUNTIME__FORCE_SHUTDOWN_DURATION: "10",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  for (const output of [child.stdout, child.stderr])
    output?.on("data", (data) => {
      logs = (logs + data).slice(-8000);
    });
  try {
    for (let i = 0; i < 200; i++) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Engine exited: ${spawnError ?? logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.status < 500)
          return { child, stop: () => stopProcess(child) };
      } catch {}
      await pause(100);
    }
    throw new Error(`Engine startup timed out: ${logs}`);
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
}
