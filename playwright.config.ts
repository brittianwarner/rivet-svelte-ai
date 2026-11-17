import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const enginePort = Number(process.env.E2E_ENGINE_PORT || 6540);
const engineEndpoint = `http://127.0.0.1:${enginePort}`;
const production = Boolean(process.env.E2E_PRODUCTION);
// Production: the one Bun server serves web, /api and /rivet on this port.
// Development: Vite serves the web and forwards /api and /rivet to the server.
const webPort = 5174;
const serverPort = production ? webPort : 3002;
const site = `http://127.0.0.1:${webPort}`;

// Separate ports from the developer's app; no provider credentials or cloud traffic.
export const serverEnv = {
  ROLE: "app",
  PORT: String(serverPort),
  HOST: "127.0.0.1",
  PUBLIC_ORIGIN: site,
  WEB_ORIGINS: site,
  RIVET_ENDPOINT: engineEndpoint,
  RIVET_TOKEN: "default",
  RIVET_NAMESPACE: "default",
  ...(production ? {} : { WEB_HANDLER: "none" }),
  // Exports land here, never in the developer's .rivet/files.
  FILES_DIR: join(tmpdir(), "rivet-e2e-files"),
  ACTOR_TOKEN: "",
  OPENROUTER_API_KEY: "",
  GOOGLE_GENERATIVE_AI_API_KEY: "",
};

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: [
    "starter.spec.ts",
    "storage.spec.ts",
    "actor-lab.spec.ts",
    "session.spec.ts",
    "data.spec.ts",
  ],
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: site, trace: "retain-on-failure" },
  webServer: [
    {
      command: "bun apps/server/tests/engine-server.ts",
      url: `${engineEndpoint}/health`,
      env: { E2E_ENGINE_PORT: String(enginePort) },
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    },
    {
      command: "bun apps/server/src/main.ts",
      url: `http://127.0.0.1:${serverPort}/api/health/actors`,
      timeout: 120_000,
      env: serverEnv,
      gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
    },
    ...(production
      ? []
      : [
          {
            command: `bun run --filter @example/web dev --port ${webPort}`,
            url: site,
            env: { API_PORT: String(serverPort) },
          },
        ]),
  ],
});
