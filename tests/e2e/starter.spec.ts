import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

test("SSR includes the learning page before JavaScript connects", async ({
  request,
}) => {
  const response = await request.get("/");
  expect(response.ok()).toBeTruthy();
  const html = await response.text();
  expect(html).toContain("Build something");
  expect(html).toContain("bun install");
  expect(html).toContain("Connecting to your actors");
});

test("two tabs share an actor over sockets and HTTP, and reload restores state", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const key = `test-${crypto.randomUUID()}`;
  const counter = page.getByRole("region", { name: "The realtime counter." });
  await page.getByLabel("Actor key").fill(key);
  await counter.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    counter.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeEnabled();
  const second = await context.newPage();
  await second.goto("/");
  const other = second.getByRole("region", { name: "The realtime counter." });
  await second.getByLabel("Actor key").fill(key);
  await other.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    other.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeEnabled();
  await counter
    .getByRole("button", { name: "+ Increment", exact: true })
    .click();
  await expect(counter.getByLabel("Counter value")).toHaveText("1");
  await expect(other.getByLabel("Counter value")).toHaveText("1");
  await other.getByRole("button", { name: "+ Via HTTP" }).click();
  await expect(counter.getByLabel("Counter value")).toHaveText("2");
  await second.reload();
  await second.getByLabel("Actor key").fill(key);
  await other.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(other.getByLabel("Counter value")).toHaveText("2");
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  await expect(page.getByText("To enable AI", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/starter-desktop.png",
    fullPage: true,
  });
});

test("mobile layout fits and API configuration failures can be retried", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/client-config", (route) =>
    route.fulfill({ status: 502, body: "unavailable" }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Try connection again" }),
  ).toBeVisible();
  await page.unroute("**/api/client-config");
  await page.getByRole("button", { name: "Try connection again" }).click();
  await expect(
    page.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeEnabled();
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(fits).toBeTruthy();
  await page.screenshot({
    path: "test-results/starter-mobile.png",
    fullPage: true,
  });
});

test("real actor validation and no-key chat settle through the gateway", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--experimental-strip-types", "apps/api/src/smoke.ts"],
    {
      env: { ...process.env, SMOKE_API_ORIGIN: "http://127.0.0.1:3002" },
      timeout: 40_000,
    },
  );
  expect(stdout).toContain("missing-provider settlement passed");
});

test("socket reconnect fetches changes missed while disconnected", async ({
  page,
  request,
}) => {
  let disconnected = false;
  const sockets: import("@playwright/test").WebSocketRoute[] = [];
  await page.routeWebSocket(/127\.0\.0\.1:6540/, (socket) => {
    if (disconnected) {
      void socket.close();
      return;
    }
    socket.connectToServer();
    sockets.push(socket);
  });
  await page.goto("/");
  const key = `reconnect-${crypto.randomUUID()}`;
  const counter = page.getByRole("region", { name: "The realtime counter." });
  await page.getByLabel("Actor key").fill(key);
  await counter.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    counter.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeEnabled();
  disconnected = true;
  await Promise.all(
    sockets.map((socket) =>
      socket.close({ code: 1012, reason: "Test disconnect" }),
    ),
  );
  await expect(
    counter.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeDisabled();
  const response = await request.post(`/api/counters/${key}/increment`, {
    data: { by: 3 },
  });
  expect(response.ok()).toBeTruthy();
  disconnected = false;
  await expect(counter.getByLabel("Counter value")).toHaveText("3");
  await expect(
    counter.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeEnabled();
});

test("web proxy rejects oversized input before forwarding it", async ({
  request,
}) => {
  const response = await request.post("/api/counters/demo/increment", {
    data: { by: 1, padding: "x".repeat(2048) },
  });
  expect(response.status()).toBe(413);
});
