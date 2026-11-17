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

/**
 * Port of the local engine (development, tests, and ROLE=all without a
 * bucket). Guard listens here; api_peer and metrics take the next two ports.
 */
export function enginePort(): number {
  return portFromEnv(process.env.ENGINE_PORT, 6440);
}

/** The admin token of a local engine. It only ever binds 127.0.0.1. */
export const LOCAL_ENGINE_TOKEN = "local-dev-token";

/** Where a local engine keeps its data: ENGINE_DATA_DIR, or `<repo>/.rivet/engine`. */
export function engineDataDir(): string {
  return (
    process.env.ENGINE_DATA_DIR?.trim() ||
    fileURLToPath(new URL("../../../.rivet/engine", import.meta.url))
  );
}

/**
 * What this process runs. One image, five presets:
 *
 * | ROLE           | engine | actors | api (/api + /rivet) | web (pages) |
 * | -------------- | ------ | ------ | ------------------- | ----------- |
 * | `all` (default)|   ✓    |   ✓    |          ✓          |      ✓      |
 * | `app`          |        |   ✓    |          ✓          |      ✓      |
 * | `engine`       |   ✓    |        |                     |             |
 * | `api`          |        |   ✓    |          ✓          |             |
 * | `web`          |        |        |      forwarded      |      ✓      |
 *
 * `all` is the single container. The three-service layout is `web` + `api` +
 * `engine`: web replicas render pages and forward /api and /rivet to the api
 * over the private network; api replicas run the actors and the API; engine
 * nodes hold the state. `app` and `api` need RIVET_ENDPOINT, `web` needs
 * API_URL. See docs/deployment.md.
 */
export type Role = "all" | "app" | "engine" | "api" | "web";

export interface Services {
  /** A Rivet engine node (storage, Guard, gateway). */
  engine: boolean;
  /** The actor runner: registers with the engine and executes actors. */
  actors: boolean;
  /** /api (Elysia) and the /rivet edge. */
  api: boolean;
  /** The SvelteKit pages. */
  web: boolean;
}

const PRESETS: Record<Role, Services> = {
  all: { engine: true, actors: true, api: true, web: true },
  app: { engine: false, actors: true, api: true, web: true },
  engine: { engine: true, actors: false, api: false, web: false },
  api: { engine: false, actors: true, api: true, web: false },
  web: { engine: false, actors: false, api: false, web: true },
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
  /** Engine admin token. Null only for an external engine without auth. */
  adminToken: string | null;
  namespace: string;
  pool: string;
  /** True when RIVET_ENDPOINT is unset: this process starts a local engine. */
  local: boolean;
}

export function rivetTarget(): RivetTarget {
  const endpoint = process.env.RIVET_ENDPOINT?.trim();
  const token = process.env.RIVET_TOKEN?.trim();
  return {
    endpoint: endpoint || `http://127.0.0.1:${enginePort()}`,
    adminToken: token || (endpoint ? null : LOCAL_ENGINE_TOKEN),
    namespace: process.env.RIVET_NAMESPACE?.trim() || "default",
    pool: process.env.RIVET_POOL?.trim() || "default",
    local: !endpoint,
  };
}

/**
 * ROLE=web: the api service's private base URL, e.g.
 * `http://api.railway.internal:8080`. No path, no credentials.
 */
export function apiUrl(): string {
  const value = process.env.API_URL?.trim();
  if (!value)
    throw new Error("ROLE=web needs API_URL (the api service's private URL).");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("API_URL must be an http(s) URL.");
  if (
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error("API_URL must be a bare origin: no path or credentials.");
  return url.origin;
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
