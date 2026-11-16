import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * One place reads the environment. Everything else takes values as arguments,
 * so tests never depend on the shell they run in.
 */

let loaded = false;

/** Bun already loads `.env` from the working directory; this adds the repo root. */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;
  const root = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(root)) process.loadEnvFile(root);
  // An empty token is otherwise treated as an explicit invalid credential by Rivet.
  for (const key of ["RIVET_ENDPOINT", "RIVET_TOKEN", "RIVET_NAMESPACE"]) {
    if (process.env[key] !== undefined && !process.env[key]?.trim())
      delete process.env[key];
  }
}

export function portFromEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (!value?.trim()) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65534) {
    throw new Error("Port must be an integer between 1 and 65534.");
  }
  return port;
}

/** Port of the engine RivetKit spawns in local development. */
export function enginePort(): number {
  return portFromEnv(process.env.RIVET_RUN_ENGINE_PORT, 6440);
}

/**
 * What this process runs. One image, five presets:
 *
 * | ROLE           | engine | actors | front (web + /api + /rivet) |
 * | -------------- | ------ | ------ | --------------------------- |
 * | `all` (default)|   ✓    |   ✓    |              ✓              |
 * | `app`          |        |   ✓    |              ✓              |
 * | `engine`       |   ✓    |        |                             |
 * | `runner`       |        |   ✓    |                             |
 * | `front`        |        |        |              ✓              |
 *
 * `all` is the single container. Split along these seams when one part needs
 * to scale on its own: engine nodes hold state, runners execute actors, front
 * replicas serve HTTP and sockets. Every role except `all` and `engine` needs
 * RIVET_ENDPOINT.
 */
export type Role = "all" | "app" | "engine" | "runner" | "front";

export interface Services {
  /** A Rivet engine node (storage, Guard, gateway). */
  engine: boolean;
  /** The actor runner: registers with the engine and executes actors. */
  actors: boolean;
  /** The public port: SvelteKit, /api and the /rivet edge. */
  front: boolean;
}

const PRESETS: Record<Role, Services> = {
  all: { engine: true, actors: true, front: true },
  app: { engine: false, actors: true, front: true },
  engine: { engine: true, actors: false, front: false },
  runner: { engine: false, actors: true, front: false },
  front: { engine: false, actors: false, front: true },
};

export function role(): Role {
  const value = process.env.ROLE?.trim() || "all";
  if (value in PRESETS) return value as Role;
  throw new Error(
    `ROLE must be one of ${Object.keys(PRESETS).join(", ")} (got ${JSON.stringify(value)}).`,
  );
}

export function servicesFor(value: Role): Services {
  return PRESETS[value];
}

export interface RivetTarget {
  /** Where the actor runner and the gateway proxy reach the engine. */
  endpoint: string;
  /** Engine admin token. Absent only for the local development engine. */
  adminToken: string | null;
  namespace: string;
  pool: string;
  /** True when RivetKit spawns a development engine for us. */
  spawnLocal: boolean;
}

export function rivetTarget(): RivetTarget {
  const endpoint = process.env.RIVET_ENDPOINT?.trim();
  return {
    endpoint: endpoint || `http://127.0.0.1:${enginePort()}`,
    adminToken: process.env.RIVET_TOKEN?.trim() || null,
    namespace: process.env.RIVET_NAMESPACE?.trim() || "default",
    pool: process.env.RIVET_POOL?.trim() || "default",
    spawnLocal: !endpoint,
  };
}

/**
 * Browser origins allowed to call the API and open actor sockets:
 * PUBLIC_ORIGIN (the deployed site) plus WEB_ORIGINS (local dev by default).
 * Actors read this too, so every replica must see the same values.
 */
export function allowedOrigins(): string[] {
  const listed = [
    process.env.PUBLIC_ORIGIN,
    process.env.WEB_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173",
  ]
    .join(",")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => new URL(origin).origin);
  return [...new Set(listed)];
}

/** Public demo parameter, not user authentication. */
export function actorToken(): string | null {
  return process.env.ACTOR_TOKEN?.trim() || null;
}
