import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

// The site origin: scripts reach /api and /rivet exactly as the browser does.
const serverOrigin = "http://127.0.0.1:5174";

test("optional repository chat actor streams, reconnects, cancels, and recovers", async () => {
  const { stdout } = await promisify(execFile)(
    "bun",
    ["apps/server/tests/chat-integration.ts"],
    {
      env: { ...process.env, SMOKE_API_ORIGIN: serverOrigin },
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
