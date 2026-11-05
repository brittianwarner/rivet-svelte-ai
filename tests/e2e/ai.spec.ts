import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

test("optional repository chat actor streams, reconnects, cancels, and recovers", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["apps/api/tests/chat-integration.ts"],
    {
      env: { ...process.env, SMOKE_API_ORIGIN: "http://127.0.0.1:3002" },
      timeout: 50_000,
    },
  );
  expect(stdout).toContain(
    "socket events, reconnect snapshot, and isolation passed",
  );
  expect(stdout).toContain(
    "partial cancellation, provider failure, and retry passed",
  );
  expect(stdout).toContain("cancellation before the first token passed");
});
