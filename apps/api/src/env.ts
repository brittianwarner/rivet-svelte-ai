import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Fill unset variables from a dotenv file. Existing process env wins. */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;

  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Load the repo-root env file whether the process cwd is the repo or apps/api. */
export function loadRootEnv(): void {
  const cwd = process.cwd();
  loadEnvFile(resolve(cwd, "../../.env"));
  loadEnvFile(resolve(cwd, ".env"));
}

/**
 * Local engine port. 6430 stays off the usual 6420 so this example can run
 * beside another Rivet engine on 6420–6430.
 */
export function enginePort(): number {
  const raw = process.env.RIVET_RUN_ENGINE_PORT?.trim();
  const parsed = raw ? Number(raw) : 6440;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65535 ? parsed : 6440;
}

/** Endpoint the browser uses for actor sockets. */
export function publicEndpoint(): string {
  const configured = process.env.RIVET_PUBLIC_ENDPOINT?.trim();
  return configured || `http://127.0.0.1:${enginePort()}`;
}

/** Demo gate token. Null when the example is open on localhost. */
export function actorToken(): string | null {
  const token = process.env.ACTOR_TOKEN?.trim();
  return token ? token : null;
}
