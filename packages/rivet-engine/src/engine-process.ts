/**
 * Runs one Rivet engine node as a child of this Bun process (ROLE=all|engine).
 *
 * Every replica is one engine node. Nodes find each other through heartbeats
 * in the shared bucket and replicate recent writes over api_peer (6421,
 * private network only). A write is acknowledged once a majority of its
 * replicas hold it on local disk, then moves to the bucket. With three or
 * more replicas a single lost container loses nothing; a node that restarts
 * joins as a new worker and balancing re-replicates onto it.
 *
 * The supervisor owns three things the engine cannot do by itself:
 *   1. advertise this container's own private IPv6 (replicas share one DNS
 *      name, and the engine config has no interpolation);
 *   2. map the plain S3_* variables onto the engine's config keys;
 *   3. stop in order: the caller drains actors first, then the engine gets
 *      SIGTERM and up to ENGINE_STOP_TIMEOUT_MS to hand off its partitions.
 */
import type { Subprocess } from "bun";
import { log } from "@example/config";

/** Engine 3.x stop: storage handoff (up to 8 min) plus teardown. */
const DEFAULT_STOP_TIMEOUT_MS = 590_000;
const HEALTH_TIMEOUT_MS = 180_000;

/**
 * First unique-local (fd00::/8) address from /proc/net/if_inet6.
 * Each line is `<32 hex> <ifindex> <prefix> <scope> <flags> <name>`.
 */
export function privateIpv6(ifInet6: string): string | null {
  for (const line of ifInet6.split("\n")) {
    const hex = line.trim().split(/\s+/)[0] ?? "";
    if (!/^fd[0-9a-f]{30}$/i.test(hex)) continue;
    return hex.match(/.{4}/g)!.join(":").toLowerCase();
  }
  return null;
}

export interface S3Settings {
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  virtualHosted: boolean;
}

/** Reads S3_*; returns the names that are missing so boot fails with a clear message. */
export function s3FromEnv(
  env: Record<string, string | undefined>,
): { settings: S3Settings } | { missing: string[] } {
  const required = [
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ] as const;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length > 0) return { missing };
  return {
    settings: {
      bucket: env.S3_BUCKET!.trim(),
      region: env.S3_REGION?.trim() || "auto",
      endpoint: env.S3_ENDPOINT!.trim().replace(/\/+$/, ""),
      accessKeyId: env.S3_ACCESS_KEY_ID!.trim(),
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!.trim(),
      prefix: env.S3_PREFIX?.trim() || "rivet/",
      virtualHosted: (env.S3_VIRTUAL_HOSTED ?? "true") !== "false",
    },
  };
}

/**
 * The engine's S3 client has no addressing-style setting. With virtual-hosted
 * requests on, the endpoint itself must already carry the bucket host.
 *
 * It also only speaks https: given an http:// endpoint it sends nothing and
 * the engine hangs at boot until its config deadline (verified on 3.1.1). So
 * an http endpoint is a boot error here, not a 30-second mystery.
 */
export function s3Endpoint(
  settings: Pick<S3Settings, "bucket" | "endpoint" | "virtualHosted">,
): string {
  const url = new URL(settings.endpoint);
  if (url.protocol !== "https:") {
    throw new Error(
      "S3_ENDPOINT must use https: the Rivet engine's S3 client does not speak plain http.",
    );
  }
  if (!settings.virtualHosted) return url.origin;
  if (!url.hostname.startsWith(`${settings.bucket}.`))
    url.hostname = `${settings.bucket}.${url.hostname}`;
  return url.origin;
}

export interface EngineEnvInput {
  adminToken: string;
  s3: S3Settings;
  /** `[addr]:6421` other nodes dial. Null only when running a single node. */
  advertise: string | null;
  /** 127.0.0.1 when only this container talks to Guard; :: when app replicas do. */
  guardHost: string;
  base: Record<string, string | undefined>;
}

/**
 * Operator-set RIVET__* values always win; these are the defaults that make
 * an ephemeral, S3-backed node correct.
 */
export function engineEnv(input: EngineEnvInput): Record<string, string> {
  const defaults: Record<string, string> = {
    RIVET__AUTH__ADMIN_TOKEN: input.adminToken,
    RIVET__GUARD__HOST: input.guardHost,
    RIVET__API_PEER__HOST: "::",
    RIVET__STORAGE__LOG_DIRECTORY: "/data/rivet",
    // Several workers: balancing places and replaces partitions. Never
    // auto-provision (that is the single-process development mode).
    RIVET__STORAGE__BALANCING__ENABLED: "true",
    // Set both sizes explicitly so the engine skips its automatic free-space
    // reserve, which is sized for dedicated disks.
    RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(4 * 1024 ** 3),
    RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: String(512 * 1024 ** 2),
    // Shrinks the window in which a write lives only on node disks (default 60 s).
    RIVET__STORAGE__WRITE_TO_COLD_AFTER_MS: "15000",
    RIVET__PEGBOARD__SQLITE_SESSIONS: "16384",
    RIVET__TELEMETRY__ENABLED: "false",
    AWS_VIRTUAL_HOSTED_STYLE_REQUEST: String(input.s3.virtualHosted),
    RIVET__OBJECT_STORAGE__PRIMARY__S3__BUCKET: input.s3.bucket,
    RIVET__OBJECT_STORAGE__PRIMARY__S3__REGION: input.s3.region,
    RIVET__OBJECT_STORAGE__PRIMARY__S3__ENDPOINT: s3Endpoint(input.s3),
    RIVET__OBJECT_STORAGE__PRIMARY__S3__ACCESS_KEY_ID: input.s3.accessKeyId,
    RIVET__OBJECT_STORAGE__PRIMARY__S3__SECRET_ACCESS_KEY:
      input.s3.secretAccessKey,
    RIVET__OBJECT_STORAGE__PRIMARY__S3__PREFIX: input.s3.prefix,
  };
  if (input.advertise)
    defaults.RIVET__API_PEER__ADVERTISE_ADDRESS = input.advertise;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base)) {
    // The child never sees app secrets it does not need.
    if (value === undefined || key.startsWith("S3_") || key === "RIVET_TOKEN")
      continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (!env[key]?.trim()) env[key] = value;
  }
  return env;
}

export interface EngineHandle {
  /** Local Guard URL for the runner and the gateway proxy. */
  endpoint: string;
  /** Resolves when the child exits; rejects never. */
  exited: Promise<number>;
  /** SIGTERM, wait up to the stop budget, then SIGKILL. */
  stop(): Promise<void>;
}

export interface StartEngineOptions {
  adminToken: string;
  guardHost: string;
  binary?: string;
  env?: Record<string, string | undefined>;
  stopTimeoutMs?: number;
}

export async function startEngineNode(
  opts: StartEngineOptions,
): Promise<EngineHandle> {
  const base = opts.env ?? process.env;
  const s3 = s3FromEnv(base);
  if ("missing" in s3) {
    throw new Error(
      `The engine needs an S3 bucket. Set ${s3.missing.join(", ")}.`,
    );
  }

  let advertise = base.RIVET__API_PEER__ADVERTISE_ADDRESS?.trim() || null;
  if (!advertise) {
    const file = Bun.file("/proc/net/if_inet6");
    const ip6 = (await file.exists()) ? privateIpv6(await file.text()) : null;
    advertise = ip6 ? `[${ip6}]:6421` : null;
  }
  if (!advertise) {
    log.warn("rivet engine: no private IPv6 found; running as a single node");
  }

  const env = engineEnv({
    adminToken: opts.adminToken,
    s3: s3.settings,
    advertise,
    guardHost: opts.guardHost,
    base,
  });
  const binary =
    opts.binary ?? base.RIVET_ENGINE_BIN ?? "/usr/bin/rivet-engine";
  await Bun.$`mkdir -p ${env.RIVET__STORAGE__LOG_DIRECTORY}`.quiet();

  const child: Subprocess = Bun.spawn([binary], {
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  log.info("rivet engine started", {
    pid: child.pid,
    advertise,
    guardHost: opts.guardHost,
  });

  const local =
    opts.guardHost === "::" || opts.guardHost === "0.0.0.0"
      ? "127.0.0.1"
      : opts.guardHost;
  const endpoint = `http://${local.includes(":") ? `[${local}]` : local}:6420`;
  const exited = child.exited.then((code) => code ?? 1);

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    const done = await Promise.race([
      exited.then(() => true),
      Bun.sleep(500).then(() => false),
    ]);
    if (done) throw new Error("The engine exited before it became healthy.");
    try {
      const res = await fetch(`${endpoint}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("The engine did not become healthy in time.");
    }
  }
  log.info("rivet engine healthy", { endpoint });

  const stopTimeoutMs =
    opts.stopTimeoutMs ??
    Number(base.ENGINE_STOP_TIMEOUT_MS ?? DEFAULT_STOP_TIMEOUT_MS);
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
          Bun.sleep(stopTimeoutMs).then(() => false),
        ]);
        if (!finished) {
          log.error("rivet engine: stop budget exceeded, killing", {
            stopTimeoutMs,
          });
          child.kill("SIGKILL");
          await exited;
        }
        log.info("rivet engine stopped");
      })();
      return stopping;
    },
  };
}
