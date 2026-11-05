import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Node's dotenv parser handles quotes, comments, and existing environment values. */
export function loadEnvFile(path: string): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

let loaded = false;

export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;
  loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
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

export function enginePort(): number {
  return portFromEnv(process.env.RIVET_RUN_ENGINE_PORT, 6440);
}

export function publicEndpoint(): string {
  const endpoint = process.env.RIVET_PUBLIC_ENDPOINT?.trim();
  if (endpoint) return endpoint;
  if (process.env.RIVET_ENDPOINT?.trim()) {
    throw new Error(
      "Set RIVET_PUBLIC_ENDPOINT to your browser-accessible Rivet endpoint.",
    );
  }
  return `http://127.0.0.1:${enginePort()}`;
}

export function allowedOrigins(): string[] {
  return (
    process.env.WEB_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173"
  )
    .split(",")
    .map((origin) => new URL(origin.trim()).origin);
}

/** Public demo parameter, not user authentication. */
export function actorToken(): string | null {
  return process.env.ACTOR_TOKEN?.trim() || null;
}
