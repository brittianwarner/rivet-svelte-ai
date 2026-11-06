import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

test("simultaneous first visits use the same browser session", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await Promise.all([page.goto("/#playground"), other.goto("/#playground")]);
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  await expect(
    other.getByLabel("Connected actors", { exact: true }),
  ).toHaveText("1");
  const id = await page
    .locator(".session-status")
    .getAttribute("data-session-id");
  await expect(other.locator(".session-status")).toHaveAttribute(
    "data-session-id",
    id!,
  );
  await other.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(page.getByLabel("Session actors", { exact: true })).toHaveText(
    "2",
  );
  await page.reload();
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "2",
  );
  await expect(page.locator(".session-status")).toHaveAttribute(
    "data-session-id",
    id!,
  );
});

test("session actor retains the registry across reloads and tabs while visitors stay isolated", async ({
  page,
  context,
  browser,
}) => {
  await page.goto("/#playground");
  const count = page.getByLabel("Connected actors", { exact: true });
  const registered = page.getByLabel("Session actors", { exact: true });
  const client = page.getByRole("region", {
    name: "Svelte client",
    exact: true,
  });
  await expect(count).toHaveText("1");
  const sessionId = await page
    .locator(".session-status")
    .getAttribute("data-session-id");
  expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);
  const firstKey = await client
    .getByLabel("Actor key", { exact: true })
    .inputValue();
  await page.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(count).toHaveText("2");
  await expect(registered).toHaveText("2");
  const secondKey = await client
    .getByLabel("Actor key", { exact: true })
    .inputValue();
  expect(secondKey).not.toBe(firstKey);
  await page.getByRole("button", { name: "+ Increment", exact: true }).click();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "1",
  );
  await client
    .getByRole("button", { name: "Disconnect actor", exact: true })
    .click();
  await expect(count).toHaveText("1");
  await expect(registered).toHaveText("2");
  await expect(page.locator(".actor-chip")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Session state", exact: true })
    .click();
  const registry = JSON.parse(
    await page.getByLabel("Session registry state").innerText(),
  );
  expect(registry.actors.map((actor: { key: string }) => actor.key)).toEqual([
    firstKey,
    secondKey,
  ]);
  await page.reload();
  await expect(count).toHaveText("2");
  await expect(page.locator(".session-status")).toHaveAttribute(
    "data-session-id",
    sessionId!,
  );
  await page.locator(".actor-chip").nth(1).click();
  await expect(client.getByLabel("Actor key", { exact: true })).toHaveValue(
    secondKey,
  );
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "1",
  );

  const secondTab = await context.newPage();
  await secondTab.goto("/#playground");
  await expect(
    secondTab.getByLabel("Connected actors", { exact: true }),
  ).toHaveText("2");
  await expect(secondTab.locator(".session-status")).toHaveAttribute(
    "data-session-id",
    sessionId!,
  );
  await secondTab
    .getByRole("button", { name: "Add actor", exact: true })
    .click();
  await expect(count).toHaveText("3");
  await expect(registered).toHaveText("3");

  const isolated = await browser.newContext();
  try {
    const visitor = await isolated.newPage();
    await visitor.goto("http://127.0.0.1:5174/#playground");
    await expect(
      visitor.getByLabel("Connected actors", { exact: true }),
    ).toHaveText("1");
    await expect(visitor.locator(".session-status")).not.toHaveAttribute(
      "data-session-id",
      sessionId!,
    );
    await expect(
      visitor.getByLabel("Actor key", { exact: true }),
    ).not.toHaveValue(firstKey);
    await expect(
      visitor.getByLabel("Counter value", { exact: true }),
    ).toHaveText("0");
  } finally {
    await isolated.close();
  }
});

test("real session actions are idempotent, bounded, and restore their actors", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["apps/api/tests/session-integration.ts"],
    {
      env: { ...process.env, SMOKE_API_ORIGIN: "http://127.0.0.1:3002" },
      timeout: 50_000,
    },
  );
  expect(stdout).toContain("session integration passed");
});

test("canvas add, remove, and undo synchronize membership and preserve counter state", async ({
  page,
  context,
}) => {
  await page.goto("/#playground");
  const canvasControls = page.getByRole("region", {
    name: "Live actor anatomy",
  });
  const saved = page.getByLabel("Session actors", { exact: true });
  await expect(saved).toHaveText("1");
  const other = await context.newPage();
  await other.goto("/#playground");
  await expect(other.getByLabel("Session actors", { exact: true })).toHaveText(
    "1",
  );
  await canvasControls.getByRole("button", { name: "Add actor" }).click();
  await expect(saved).toHaveText("2");
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "2",
  );
  await expect(page.locator(".actor-marker")).toHaveCount(2);
  await page.getByRole("button", { name: "+ Increment", exact: true }).click();
  await expect(page.getByLabel("Counter value", { exact: true })).toHaveText(
    "1",
  );
  const key = await page.getByLabel("Actor key", { exact: true }).inputValue();
  await canvasControls
    .getByRole("button", { name: "Remove counter-02 from playground" })
    .click();
  await expect(saved).toHaveText("1");
  await expect(
    other.getByLabel("Connected actors", { exact: true }),
  ).toHaveText("1");
  await expect(page.locator(".actor-marker")).toHaveCount(1);
  await expect(page.locator(".canvas-notice")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo remove", exact: true }).click();
  await expect(saved).toHaveText("2");
  await expect(page.getByLabel("Actor key", { exact: true })).toHaveValue(key);
  await expect(page.getByLabel("Counter value", { exact: true })).toHaveText(
    "1",
  );
  await canvasControls
    .getByRole("button", { name: "Remove counter-02 from playground" })
    .click();
  await canvasControls
    .getByRole("button", { name: "Remove counter-01 from playground" })
    .click();
  await expect(saved).toHaveText("0");
  await page.reload();
  await expect(
    page.getByText(
      "Your session is intentionally empty. Add an actor when you are ready.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(saved).toHaveText("0");
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "0",
  );
  await page.screenshot({
    path: "test-results/design-empty.png",
    fullPage: true,
  });
  await canvasControls.getByRole("button", { name: "Add actor" }).click();
  await expect(saved).toHaveText("1");
  await expect(page.getByLabel("Counter value", { exact: true })).toHaveText(
    "0",
  );
  // Fill, remove a middle member, and refill: pooled models must not share sockets.
  for (let i = 2; i <= 7; i++) {
    await canvasControls.getByRole("button", { name: "Add actor" }).click();
    await expect(saved).toHaveText(String(i));
    await expect(
      canvasControls.getByRole("button", { name: /Remove .* from playground/ }),
    ).toBeEnabled();
  }
  await page.locator(".actor-marker").nth(2).click();
  await canvasControls
    .getByRole("button", { name: /Remove .* from playground/ })
    .click();
  await expect(saved).toHaveText("6");
  await page.getByRole("button", { name: "Undo remove", exact: true }).click();
  await expect(saved).toHaveText("7");
  await expect(
    page.getByRole("region", { name: "Svelte client" }).getByRole("heading"),
  ).toBeFocused();
  await canvasControls
    .getByRole("button", { name: /Remove .* from playground/ })
    .click();
  await expect(saved).toHaveText("6");
  await canvasControls.getByRole("button", { name: "Add actor" }).click();
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "7",
  );
  await expect(
    other.getByLabel("Connected actors", { exact: true }),
  ).toHaveText("7");
  await expect(page.locator(".actor-marker")).toHaveCount(7);
  await page.getByRole("button", { name: "+ Increment", exact: true }).click();
  await expect(page.getByLabel("Counter value", { exact: true })).toHaveText(
    "1",
  );
});

test("mobile canvas controls support keyboard removal and undo without WebGL", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      ...args: Parameters<typeof getContext>
    ) {
      if (String(args[0]).includes("webgl")) return null;
      return getContext.apply(this, args);
    } as typeof getContext;
  });
  await page.goto("/#playground");
  await expect(
    page.getByRole("button", { name: "Flat view", exact: true }),
  ).toBeVisible();
  const add = page.getByRole("button", { name: "Add actor" });
  await add.click();
  await expect(page.getByLabel("Session actors", { exact: true })).toHaveText(
    "2",
  );
  const remove = page.getByRole("button", {
    name: "Remove counter-02 from playground",
  });
  await remove.focus();
  await remove.press("Enter");
  await expect(page.getByLabel("Session actors", { exact: true })).toHaveText(
    "1",
  );
  await expect(
    page.getByRole("button", { name: "Undo remove", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Undo remove", exact: true }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Undo remove", exact: true }).click();
  await expect(page.getByLabel("Session actors", { exact: true })).toHaveText(
    "2",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
