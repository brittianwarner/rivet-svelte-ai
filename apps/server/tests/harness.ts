import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "rivetkit/client";
import type { ClientConfig } from "@example/wire";
import type { AppRegistry } from "@example/actors";
import { pause, startIsolatedEngine } from "./engine.ts";

/**
 * A real engine plus the real server, as one replica sees them in production
 * (ROLE=app pointed at an engine). Dedicated ports and a temporary data
 * directory: never touches the developer's local engine or database.
 */
export interface Harness {
  origin: string;
  config: ClientConfig;
  /** A fresh client through the public /rivet edge, the way a browser connects. */
  connect(): ReturnType<typeof createClient<AppRegistry>>;
  /** Stop the server processes only. The engine keeps running so state can be checked after a restart. */
  stopServer(): Promise<void>;
  startServer(): Promise<void>;
  logs(): string;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  enginePort?: number;
  port?: number;
  env?: Record<string, string>;
  /** A module Bun loads before the server, e.g. the local model fixture. */
  preload?: string;
  /**
   * One server process per role, all on the same engine. The default `["app"]`
   * is one replica of the single container with its engine elsewhere;
   * `["runner", "front"]` is the split tier layout. The role that serves the
   * front gets `port`; the others get the ports after it.
   */
  roles?: ("app" | "runner" | "front")[];
}

/** A client that reaches actors the way a browser does: through `<origin>/rivet`. */
export function edgeClient(origin: string, config: ClientConfig) {
  return createClient<AppRegistry>({
    endpoint: config.rivetEndpoint,
    namespace: config.rivetNamespace,
    // The edge denies /actors; actions resolve through the gateway query.
    gateway: { skipReadyWait: true },
    disableMetadataLookup: true,
    headers: { origin },
  });
}

const entry = new URL("../src/main.ts", import.meta.url).pathname;

/** Every harness replica signs and verifies principal tokens with this. */
export const HARNESS_ENTITY_SECRET = "harness-entity-secret";

export async function startHarness(
  opts: HarnessOptions = {},
): Promise<Harness> {
  const enginePort = opts.enginePort ?? 6560;
  const port = opts.port ?? 3010;
  const origin = `http://127.0.0.1:${port}`;
  const directory = await mkdtemp(join(tmpdir(), "rivet-harness-"));
  let output = "";
  const capture = (source: string, data: unknown) => {
    output = (output + `[${source}] ${String(data)}`).slice(-60_000);
  };

  const engine = await startIsolatedEngine(directory, enginePort);
  engine.child.stdout?.on("data", (data) => capture("engine", data));
  engine.child.stderr?.on("data", (data) => capture("engine", data));

  const roles = opts.roles ?? ["app"];
  const portFor = (index: number) => {
    const frontIndex = roles.findIndex((r) => r !== "runner");
    if (index === frontIndex) return port;
    return port + 1 + index;
  };
  let servers: ReturnType<typeof Bun.spawn>[] = [];

  const spawnRole = async (role: string, rolePort: number) => {
    const server = Bun.spawn(
      [
        process.execPath,
        ...(opts.preload ? ["--preload", opts.preload] : []),
        entry,
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          NODE_ENV: "test",
          ROLE: role,
          PORT: String(rolePort),
          HOST: "127.0.0.1",
          PUBLIC_ORIGIN: origin,
          WEB_ORIGINS: origin,
          RIVET_ENDPOINT: `http://127.0.0.1:${enginePort}`,
          RIVET_TOKEN: "default",
          RIVET_NAMESPACE: "default",
          ACTOR_TOKEN: "",
          OPENROUTER_API_KEY: "",
          GOOGLE_GENERATIVE_AI_API_KEY: "",
          // Replicas verify each other's principal tokens: share one secret.
          ENTITY_SECRET: HARNESS_ENTITY_SECRET,
          // No web build in tests: the server answers /api and /rivet only.
          WEB_HANDLER: "none",
          ...opts.env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    servers.push(server);
    void drain(server.stdout, (data) => capture(role, data));
    void drain(server.stderr, (data) => capture(role, data));
    for (let i = 0; i < 300; i++) {
      if (server.exitCode !== null)
        throw new Error(`${role} exited (${server.exitCode}): ${output}`);
      try {
        const ready = await fetch(
          `http://127.0.0.1:${rolePort}/api/health/actors`,
          { signal: AbortSignal.timeout(1000) },
        );
        if (ready.ok) return;
      } catch {}
      await pause(100);
    }
    throw new Error(`${role} startup timed out: ${output}`);
  };
  const startServer = async () => {
    // Runners first, so the front never reports ready with nothing to serve.
    const order = roles
      .map((role, index) => ({ role, index }))
      .sort(
        (a, b) => Number(a.role !== "runner") - Number(b.role !== "runner"),
      );
    for (const { role, index } of order) await spawnRole(role, portFor(index));
  };
  const stopServer = async () => {
    const current = servers;
    servers = [];
    await Promise.all(
      current.map(async (server) => {
        if (server.exitCode !== null) return;
        server.kill("SIGTERM");
        const killer = setTimeout(() => server.kill("SIGKILL"), 15_000);
        await server.exited;
        clearTimeout(killer);
      }),
    );
  };

  try {
    await startServer();
  } catch (error) {
    await stopServer();
    await engine.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const config = (await (
    await fetch(`${origin}/api/client-config`)
  ).json()) as ClientConfig;
  return {
    origin,
    config,
    connect: () => edgeClient(origin, config),
    startServer,
    stopServer,
    logs: () => output,
    stop: async () => {
      await stopServer();
      await engine.stop();
      if (process.env.KEEP_HARNESS_DIAGNOSTICS === "1") {
        await Bun.write(join(directory, "harness.log"), output);
        console.error(`Harness directory: ${directory}`);
      } else {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

async function drain(
  stream: ReadableStream<Uint8Array> | number | undefined,
  sink: (text: string) => void,
) {
  if (!stream || typeof stream === "number") return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) sink(decoder.decode(chunk));
}
