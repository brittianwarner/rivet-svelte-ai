import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { openKeySettings } from "./playground-helpers";

test("keyboard navigation reveals the skip link and reaches main content", async ({
  page,
}) => {
  await page.goto("/");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await expect(skip).toHaveCSS("clip-path", "none");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  await page.keyboard.press("Tab");
  await expect(skip).not.toBeFocused();
  await expect(skip).toHaveCSS("clip-path", "inset(50%)");
});

test("browser credential outages retry slowly and recover", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/client-token", (route) => {
    requests++;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"unavailable"}',
    });
  });
  await page.goto("/");
  await expect.poll(() => requests).toBeGreaterThan(0);
  await page.waitForTimeout(3_000);
  expect(requests).toBeLessThanOrEqual(3);
  await page.unroute("**/api/client-token");
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
});

test("SSR includes the learning page before JavaScript connects", async ({
  request,
}) => {
  const response = await request.get("/");
  expect(response.ok()).toBeTruthy();
  const html = await response.text();
  expect(html).toContain("Change");
  expect(html).toContain("One at a time.");
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
  const counter = page.getByRole("region", { name: "Svelte client" });
  await openKeySettings(page);
  await page.getByLabel("Actor key").fill(key);
  await counter.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeEnabled();
  const second = await context.newPage();
  await second.goto("/");
  const other = second.getByRole("region", { name: "Svelte client" });
  await openKeySettings(second);
  await second.getByLabel("Actor key").fill(key);
  await other.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    second.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "+ Increment", exact: true }).click();
  await expect(counter.getByLabel("Counter value")).toHaveText("1");
  await expect(other.getByLabel("Counter value")).toHaveText("1");
  await other.getByRole("button", { name: "+ Via HTTP" }).click();
  await expect(counter.getByLabel("Counter value")).toHaveText("2");
  await second.reload();
  await openKeySettings(second);
  await second.getByLabel("Actor key").fill(key);
  await other.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(other.getByLabel("Counter value")).toHaveText("2");
  await expect(
    page.getByRole("region", { name: "A conversation with memory." }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(
    0,
  );
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
  await page.routeWebSocket(
    new RegExp(`127\\.0\\.0\\.1:${process.env.E2E_ENGINE_PORT || 6540}`),
    (socket) => {
      if (disconnected) {
        void socket.close();
        return;
      }
      socket.connectToServer();
      sockets.push(socket);
    },
  );
  await page.goto("/");
  const key = `reconnect-${crypto.randomUUID()}`;
  const counter = page.getByRole("region", { name: "Svelte client" });
  await openKeySettings(page);
  await page.getByLabel("Actor key").fill(key);
  await counter.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    counter.getByRole("heading", { name: "counter-02", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeEnabled();
  disconnected = true;
  await Promise.all(
    sockets.map((socket) =>
      socket.close({ code: 1012, reason: "Test disconnect" }),
    ),
  );
  await expect(
    page.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeDisabled();
  const response = await request.post(`/api/counters/${key}/increment`, {
    data: { by: 3 },
  });
  expect(response.ok()).toBeTruthy();
  disconnected = false;
  await expect(counter.getByLabel("Counter value")).toHaveText("3");
  await expect(
    page.getByRole("button", { name: "+ Increment", exact: true }),
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

test("mobile navigation, key guidance, and long actor keys remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Get started", exact: true }),
  ).toBeVisible();
  const counter = page.getByRole("region", { name: "Svelte client" });
  await openKeySettings(counter);
  const input = page.getByLabel("Actor key", { exact: false });
  await expect(counter.locator(".key-form p")).toContainText(
    "letters, numbers or hyphens",
  );
  await input.fill("Team-Room");
  await counter.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(input).toHaveValue("team-room");
  const key = "room-" + "a".repeat(59);
  await input.fill(key);
  await counter.getByRole("button", { name: "Connect", exact: true }).click();
  const dock = page
    .getByRole("region", { name: "Live actor anatomy" })
    .locator(".actor-dock");
  expect(
    await dock.evaluate(
      (element) => element.getBoundingClientRect().right <= innerWidth,
    ),
  ).toBeTruthy();
  await expect(
    page.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeEnabled();
});

test("homepage stays counter-focused without starting AI or chat connections", async ({
  page,
}) => {
  let providerRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/ready")) providerRequests++;
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("region", { name: "Conversation", exact: true }),
  ).toHaveCount(0);
  expect(providerRequests).toBe(0);
});

test("quickstart copy controls report success without shifting the page", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => {} },
    });
  });
  await page.goto("/#start");
  await page.evaluate(() => document.fonts.ready);
  const start = page.locator("#start");
  const height = await start.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await page
    .getByRole("button", {
      name: "Copy install dependencies command",
      exact: true,
    })
    .click();
  await expect(start.getByRole("status")).toContainText(/copied/i);
  expect(
    await start.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeCloseTo(height, 0);
});
