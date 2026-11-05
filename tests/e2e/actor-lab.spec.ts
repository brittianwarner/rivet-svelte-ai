import { expect, test } from "@playwright/test";

test("the live Svelte client controls independent real actors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#playground");
  await expect(page).toHaveTitle("rivet + svelte");
  const lab = page.getByRole("region", { name: "Live actor anatomy" });
  const client = lab.getByRole("region", {
    name: "Svelte client",
    exact: true,
  });
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  await lab.screenshot({ path: "test-results/actor-playground-initial.png" });
  await lab.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "2",
  );
  await expect(
    client.getByRole("heading", { name: "counter-02", exact: true }),
  ).toBeVisible();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "0",
  );
  await client
    .getByRole("button", { name: "+ Increment", exact: true })
    .click();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "1",
  );
  await client.getByRole("button", { name: "+ Via HTTP", exact: true }).click();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "2",
  );
  await expect(lab.locator(".activity-line")).toContainText("Svelte updated");
  const height = await lab
    .locator(".scene-viewport")
    .evaluate((element) => element.getBoundingClientRect().height);
  await lab
    .getByRole("button", { name: "Svelte connection", exact: true })
    .click();
  await expect(lab.getByLabel("Actor connection example")).toContainText(
    "useActor",
  );
  await expect(lab.getByLabel("Actor connection example")).toContainText(
    "$props()",
  );
  await lab.getByRole("button", { name: "View model", exact: true }).click();
  await expect(lab.getByLabel("Actor view model example")).toContainText(
    "createReactiveActor",
  );
  await expect(lab.getByLabel("Actor view model example")).toContainText(
    "actor.dispose()",
  );
  expect(
    await lab
      .locator(".scene-viewport")
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeCloseTo(height, 0);
  await lab.getByRole("button", { name: "Live state", exact: true }).click();
  await lab.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "3",
  );
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "0",
  );
  await client
    .getByRole("button", { name: "Disconnect actor", exact: true })
    .click();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "2",
  );
  await client
    .getByRole("button", { name: "Reconnect actor", exact: true })
    .click();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "3",
  );
  for (let i = 0; i < 4; i++)
    await lab.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "7",
  );
  await expect(
    lab.getByRole("button", { name: "Add actor", exact: true }),
  ).toBeDisabled();
  await lab.getByRole("button", { name: "Pause motion", exact: true }).click();
  await expect(
    lab.getByRole("button", { name: "Play motion", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await lab.screenshot({ path: "test-results/actor-playground-desktop.png" });
  const fieldBottom = await lab
    .locator(".field-controls")
    .evaluate((element) => element.getBoundingClientRect().bottom);
  const dockTop = await lab
    .locator(".actor-dock")
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(fieldBottom).toBeLessThanOrEqual(dockTop + 1);
  expect(errors).toEqual([]);
});

test("mobile 3D framing fits a restored seven-actor session", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#playground");
  const lab = page.getByRole("region", { name: "Live actor anatomy" });
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  await expect(lab.locator("[data-render-state]")).toHaveAttribute(
    "data-render-state",
    /ready|fallback/,
  );
  if (
    (await lab
      .locator("[data-render-state]")
      .getAttribute("data-render-state")) === "fallback"
  )
    test.skip(true, "Real WebGL unavailable; fallback has separate coverage.");
  await lab
    .locator(".actor-field")
    .screenshot({ path: "test-results/actor-playground-mobile-initial.png" });
  for (let i = 0; i < 6; i++)
    await lab.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "7",
  );
  await page.reload();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "7",
  );
  await expect(lab.locator(".actor-marker")).toHaveCount(7);
  await expect(lab.locator(".gateway-legend")).toBeVisible();
  await expect(lab.locator(".gateway-legend")).toContainText("Rivet gateway");
  await lab
    .locator(".actor-field")
    .screenshot({ path: "test-results/actor-playground-mobile-seven.png" });
  await page.screenshot({
    path: "test-results/actor-playground-mobile-full.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("mobile users retain all actor controls without WebGL or motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      type: string,
      ...args: unknown[]
    ) {
      if (type.startsWith("webgl")) return null;
      return original.call(this, type, ...args);
    } as typeof original;
  });
  await page.goto("/#playground");
  const lab = page.getByRole("region", { name: "Live actor anatomy" });
  const client = lab.getByRole("region", {
    name: "Svelte client",
    exact: true,
  });
  await expect(
    lab.getByText("3D view unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  await lab.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "2",
  );
  await client
    .getByRole("button", { name: "+ Increment", exact: true })
    .click();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "1",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("numbered scene markers remain selectable at full population", async ({
  page,
}) => {
  await page.goto("/#playground");
  const lab = page.getByRole("region", { name: "Live actor anatomy" });
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  await expect(lab.locator("[data-render-state]")).toHaveAttribute(
    "data-render-state",
    /ready|fallback/,
  );
  if (
    (await lab
      .locator("[data-render-state]")
      .getAttribute("data-render-state")) === "fallback"
  )
    test.skip(true, "WebGL unavailable; fallback is covered separately.");
  for (let i = 0; i < 6; i++)
    await lab.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "7",
  );
  const markers = lab.getByLabel("Labeled system diagram", { exact: true });
  await expect(markers.getByRole("button")).toHaveCount(7);
  await markers
    .getByRole("button", { name: "Inspect actor counter-01", exact: true })
    .click();
  await expect(
    lab
      .getByRole("region", { name: "Svelte client", exact: true })
      .getByRole("heading", { name: "counter-01", exact: true }),
  ).toBeVisible();
  await expect(
    markers.getByRole("button", {
      name: "Inspect actor counter-01",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await lab.getByRole("button", { name: "Rotate view", exact: true }).click();
  await lab.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(markers.getByRole("button")).toHaveCount(7);
});

test("connecting an already-open key selects its actor without duplicate connections", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#playground");
  const lab = page.getByRole("region", { name: "Live actor anatomy" });
  const client = lab.getByRole("region", {
    name: "Svelte client",
    exact: true,
  });
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  await lab.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "2",
  );
  const key = await client
    .getByLabel("Actor key", { exact: true })
    .inputValue();
  await lab.locator(".actor-chip").first().click();
  await client.getByLabel("Actor key", { exact: true }).fill(key);
  await client.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    client.getByRole("heading", { name: "counter-02", exact: true }),
  ).toBeVisible();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "2",
  );
  expect(errors).toEqual([]);
});
