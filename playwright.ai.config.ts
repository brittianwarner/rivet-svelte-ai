import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const servers = Array.isArray(base.webServer)
  ? base.webServer
  : [base.webServer!];
export default defineConfig({
  ...base,
  testMatch: "ai.spec.ts",
  outputDir: "test-results/ai",
  webServer: servers.map((server) =>
    server.command === "bun apps/server/src/main.ts"
      ? {
          ...server,
          // The fixture answers openrouter.ai in-process: no paid model calls.
          command:
            "bun --preload ./tests/fixtures/provider.mjs apps/server/src/main.ts",
          env: { ...server.env, OPENROUTER_API_KEY: "local-test-key" },
        }
      : server,
  ),
});
