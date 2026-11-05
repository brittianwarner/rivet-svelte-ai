import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const servers = Array.isArray(base.webServer)
  ? base.webServer
  : [base.webServer!];
export default defineConfig({
  ...base,
  testMatch: "ai.spec.ts",
  webServer: servers.map((server) =>
    server.command.includes("@example/api")
      ? {
          ...server,
          command:
            "node --import ./tests/fixtures/provider.mjs --experimental-strip-types apps/api/src/index.ts",
          env: { ...server.env, OPENROUTER_API_KEY: "local-test-key" },
        }
      : server,
  ),
});
