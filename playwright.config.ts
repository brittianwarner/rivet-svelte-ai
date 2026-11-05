import { defineConfig } from "@playwright/test";

// Separate ports from the developer's app; no provider credentials or cloud traffic.
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["starter.spec.ts", "storage.spec.ts"],
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5174", trace: "retain-on-failure" },
  webServer: [
    {
      command: "node apps/api/tests/engine-server.ts",
      url: "http://127.0.0.1:6540/health",
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    },
    {
      command: "bun run --filter @example/api start",
      url: "http://127.0.0.1:3002/health",
      timeout: 120_000,
      env: {
        API_PORT: "3002",
        API_HOST: "127.0.0.1",
        RIVET_ENDPOINT: "http://127.0.0.1:6540",
        RIVET_TOKEN: "default",
        RIVET_NAMESPACE: "default",
        RIVET_PUBLIC_ENDPOINT: "http://127.0.0.1:6540",
        RIVET_RUN_ENGINE_PORT: "6540",
        WEB_ORIGINS: "http://127.0.0.1:5174",
        ACTOR_TOKEN: "",
        OPENROUTER_API_KEY: "",
        GOOGLE_GENERATIVE_AI_API_KEY: "",
      },
    },
    {
      command: process.env.E2E_PRODUCTION
        ? "bun run --filter @example/web start"
        : "bun run --filter @example/web dev --port 5174",
      url: "http://127.0.0.1:5174",
      env: {
        API_ORIGIN: "http://127.0.0.1:3002",
        HOST: "127.0.0.1",
        PORT: "5174",
      },
    },
  ],
});
