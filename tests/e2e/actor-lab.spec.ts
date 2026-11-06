import { expect, test } from "@playwright/test";
import { openKeySettings } from "./playground-helpers";

test("hovering playground controls preserves readable text contrast", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  await page.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "2",
  );
  const controls = page
    .getByRole("region", { name: "Live actor anatomy" })
    .getByRole("button");
  for (const control of await controls.all()) {
    if (!(await control.isVisible()) || !(await control.isEnabled())) continue;
    await control.hover();
    await control.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await expect
      .poll(
        async () =>
          control.evaluate((element) => {
            const rgb = (value: string) =>
              (value.match(/[\d.]+/g) || []).map(Number);
            const luminance = (color: number[]) =>
              color
                .slice(0, 3)
                .map((channel) => {
                  const s = channel / 255;
                  return s <= 0.04045
                    ? s / 12.92
                    : ((s + 0.055) / 1.055) ** 2.4;
                })
                .reduce(
                  (sum, channel, index) =>
                    sum + channel * [0.2126, 0.7152, 0.0722][index],
                  0,
                );
            let parent: Element | null = element;
            let background = [255, 255, 255];
            while (parent) {
              const candidate = rgb(getComputedStyle(parent).backgroundColor);
              if (candidate.length === 3 || candidate[3] === 1) {
                background = candidate;
                break;
              }
              parent = parent.parentElement;
            }
            const foreground = luminance(rgb(getComputedStyle(element).color));
            const behind = luminance(background);
            return (
              (Math.max(foreground, behind) + 0.05) /
              (Math.min(foreground, behind) + 0.05)
            );
          }),
        {
          message: `Readable hover contrast: ${(await control.getAttribute("aria-label")) || (await control.textContent())}`,
        },
      )
      .toBeGreaterThanOrEqual(4.5);
  }
});

test("a delayed response stays with its actor after selection changes", async ({
  page,
}) => {
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
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/counters/*/increment", async (route) => {
    await gate;
    await route.continue();
  });
  await client.getByRole("button", { name: "+ Via HTTP", exact: true }).click();
  await expect(
    client.getByRole("button", { name: "+ Via HTTP", exact: true }),
  ).toBeDisabled();
  await lab
    .getByRole("button", { name: "Inspect actor counter-01", exact: true })
    .click();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "0",
  );
  await expect(
    client.getByRole("button", {
      name: "Remove counter-01 from playground",
      exact: true,
    }),
  ).toBeDisabled();
  release();
  await expect(
    client.getByRole("button", { name: "+ Via HTTP", exact: true }),
  ).toBeEnabled();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "0",
  );
  await expect(lab.locator(".activity-line")).not.toContainText("counter-02");
  await lab
    .getByRole("button", { name: "Inspect actor counter-02", exact: true })
    .click();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "1",
  );
  await expect(lab.locator(".activity-line")).toContainText(
    "HTTP response received · counter-02",
  );
});

test("restoring a nonzero actor never presents an unknown snapshot as zero", async ({
  page,
}) => {
  await page.goto("/#playground");
  const client = page.getByRole("region", {
    name: "Svelte client",
    exact: true,
  });
  const value = client.getByLabel("Counter value", { exact: true });
  await expect(value).toHaveText("0");
  for (let i = 1; i <= 3; i++) {
    await page
      .getByRole("button", { name: "+ Increment", exact: true })
      .click();
    await expect(value).toHaveText(String(i));
  }
  await page.addInitScript(() => {
    const target = window as Window & { restoredCounterValues?: string[] };
    target.restoredCounterValues = [];
    const observer = new MutationObserver(() => {
      const value = document
        .querySelector('[aria-label="Counter value"]')
        ?.textContent?.trim();
      if (value) target.restoredCounterValues!.push(value);
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await page.reload();
  await expect(value).toHaveText("3");
  const rendered = await page.evaluate(
    () =>
      (window as Window & { restoredCounterValues?: string[] })
        .restoredCounterValues ?? [],
  );
  expect(rendered).toContain("3");
  expect(rendered).not.toContain("0");
});

test("HTTP actions show pending and failure without inventing state or socket events", async ({
  page,
}) => {
  await page.goto("/#playground");
  const client = page.getByRole("region", {
    name: "Svelte client",
    exact: true,
  });
  const value = client.getByLabel("Counter value", { exact: true });
  const http = client.getByRole("button", { name: "+ Via HTTP", exact: true });
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  await expect(value).toHaveText("0");

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/counters/*/increment", async (route) => {
    await gate;
    await route.continue();
  });
  await http.click();
  await expect(http).toBeDisabled();
  await expect(value).toHaveText("0");
  await page.screenshot({
    path: "test-results/design-pending.png",
    fullPage: true,
  });
  release();
  await expect(value).toHaveText("1");
  await expect(http).toBeEnabled();
  await page.unroute("**/api/counters/*/increment");

  await page.route("**/api/counters/*/increment", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporary test outage. Try again." }),
    }),
  );
  await http.click();
  await expect(client.getByRole("alert")).toContainText(
    "Temporary test outage",
  );
  await page.screenshot({
    path: "test-results/design-error.png",
    fullPage: true,
  });
  await expect(value).toHaveText("1");
  await expect(http).toBeEnabled();
  await page.unroute("**/api/counters/*/increment");

  await client
    .getByRole("button", { name: "Disconnect actor", exact: true })
    .click();
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "0",
  );
  await expect(
    page.getByRole("button", { name: "+ Increment", exact: true }),
  ).toBeDisabled();
  await http.click();
  await expect(value).toHaveText("2");
  await expect(client.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".activity-line")).toContainText("HTTP response");
  await expect(page.locator(".activity-line")).not.toContainText(
    "newCount event",
  );
  await client
    .getByRole("button", { name: "Reconnect actor", exact: true })
    .click();
  await expect(page.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  await expect(value).toHaveText("2");
});

test("the live Svelte view controls independent real actors and exposes working examples", async ({
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
  const connected = lab.getByLabel("Connected actors", { exact: true });
  const add = lab.getByRole("button", { name: "Add actor", exact: true });
  await expect(connected).toHaveText("1");
  await page.screenshot({
    path: "test-results/design-desktop-initial.png",
    fullPage: true,
  });
  await add.click();
  await expect(connected).toHaveText("2");
  await expect(
    client.getByRole("heading", { name: "counter-02", exact: true }),
  ).toBeVisible();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "0",
  );
  await page.getByRole("button", { name: "+ Increment", exact: true }).click();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "1",
  );
  await client.getByRole("button", { name: "+ Via HTTP", exact: true }).click();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "2",
  );
  await expect(lab.locator(".activity-line")).toContainText("HTTP response");
  const height = await lab
    .locator(".runtime-grid")
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
  await expect(lab.getByLabel("Actor connection example")).toContainText(
    "newCount",
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
      .locator(".runtime-grid")
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeCloseTo(height, 0);
  await lab.getByRole("button", { name: "Live state", exact: true }).click();
  await add.click();
  await expect(connected).toHaveText("3");
  await client
    .getByRole("button", { name: "Disconnect actor", exact: true })
    .click();
  await expect(connected).toHaveText("2");
  await client
    .getByRole("button", { name: "Reconnect actor", exact: true })
    .click();
  await expect(connected).toHaveText("3");
  for (let i = 0; i < 4; i++) await add.click();
  await expect(connected).toHaveText("7");
  await expect(add).toBeDisabled();
  await expect(lab.locator(".actor-marker")).toHaveCount(7);
  await lab.getByRole("button", { name: "Flat view", exact: true }).click();
  await expect(
    lab.getByRole("button", { name: "Flat view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: "test-results/design-desktop-seven.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("seven restored actors stay selectable and peer selection brings focus to nearby controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#playground");
  const lab = page.getByRole("region", { name: "Live actor anatomy" });
  const client = lab.getByRole("region", {
    name: "Svelte client",
    exact: true,
  });
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  for (let i = 0; i < 6; i++)
    await lab.getByRole("button", { name: "Add actor", exact: true }).click();
  await page.reload();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "7",
  );
  await expect(lab.locator(".actor-marker")).toHaveCount(7);
  await lab
    .getByRole("button", { name: "Inspect actor counter-07", exact: true })
    .click();
  await expect(
    client.getByRole("heading", { name: "counter-07", exact: true }),
  ).toBeFocused();
  await expect(
    client.getByRole("heading", { name: "counter-07", exact: true }),
  ).toBeInViewport();
  await client
    .getByRole("button", { name: "+ Increment", exact: true })
    .click();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "1",
  );
  await lab
    .getByRole("button", { name: "Inspect actor counter-01", exact: true })
    .click();
  await expect(client.getByLabel("Counter value", { exact: true })).toHaveText(
    "0",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/design-mobile-seven.png",
    fullPage: true,
  });
});

test("native actor actions work without WebGL and with a flat reduced-motion model", async ({
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
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  await lab.getByRole("button", { name: "Flat view", exact: true }).click();
  await expect(
    lab.getByRole("button", { name: "Flat view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await lab.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "2",
  );
  // The dimensional face remains an actual button, not a canvas hit target.
  await lab
    .getByRole("button", { name: "Increment counter-02", exact: true })
    .click();
  await expect(lab.getByLabel("Counter value", { exact: true })).toHaveText(
    "1",
  );
  const face = lab.locator(".actor-face").first();
  expect(
    await face.evaluate((element) => getComputedStyle(element).boxShadow),
  ).toBe("none");
  expect(
    await face.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    ),
  ).toBe("0s");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("connecting an already-saved key at capacity selects it without a duplicate socket", async ({
  page,
}) => {
  await page.goto("/#playground");
  const lab = page.getByRole("region", { name: "Live actor anatomy" });
  const client = lab.getByRole("region", {
    name: "Svelte client",
    exact: true,
  });
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "1",
  );
  const key = await client
    .getByLabel("Actor key", { exact: true })
    .inputValue();
  for (let i = 0; i < 6; i++)
    await lab.getByRole("button", { name: "Add actor", exact: true }).click();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "7",
  );
  await openKeySettings(client);
  await client.getByLabel("Actor key", { exact: true }).fill(key);
  await client.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    client.getByRole("heading", { name: "counter-01", exact: true }),
  ).toBeVisible();
  await expect(lab.getByLabel("Connected actors", { exact: true })).toHaveText(
    "7",
  );
  await expect(lab.getByLabel("Session actors", { exact: true })).toHaveText(
    "7",
  );
});

test.describe("phone controls", () => {
  test.use({ hasTouch: true });
  for (const width of [320, 390]) {
    test(`${width}px: touch actions, selection, undo and code stay usable`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      const lab = page.getByRole("region", { name: "Live actor anatomy" });
      const client = lab.getByRole("region", {
        name: "Svelte client",
        exact: true,
      });
      await expect(
        lab.getByLabel("Connected actors", { exact: true }),
      ).toHaveText("1");
      await expect(client.locator("details")).not.toHaveAttribute("open", "");
      const firstFace = lab.getByRole("button", {
        name: "Increment counter-01",
        exact: true,
      });
      await expect(firstFace).toBeInViewport();
      await page.screenshot({
        path: `test-results/design-${width}-initial.png`,
        fullPage: true,
      });
      const add = lab.getByRole("button", { name: "Add actor", exact: true });
      await expect(add).toHaveCount(1);
      await add.tap();
      await expect(
        lab.getByLabel("Connected actors", { exact: true }),
      ).toHaveText("2");
      await client
        .getByRole("button", { name: "+ Increment", exact: true })
        .tap();
      await expect(
        client.getByLabel("Counter value", { exact: true }),
      ).toHaveText("1");
      await lab
        .getByRole("button", {
          name: "Remove counter-02 from playground",
          exact: true,
        })
        .tap();
      await expect(
        lab.getByRole("button", { name: "Undo remove", exact: true }),
      ).toBeInViewport();
      await lab.getByRole("button", { name: "Undo remove", exact: true }).tap();
      await expect(
        client.getByLabel("Counter value", { exact: true }),
      ).toHaveText("1");
      for (let i = 0; i < 5; i++) await add.tap();
      await expect(
        lab.getByLabel("Connected actors", { exact: true }),
      ).toHaveText("7");
      await lab
        .getByRole("button", { name: "Inspect actor counter-01", exact: true })
        .tap();
      await expect(
        client.getByRole("heading", { name: "counter-01", exact: true }),
      ).toBeFocused();
      await openKeySettings(client);
      await expect(
        client.getByLabel("Actor key", { exact: true }),
      ).toBeVisible();
      await client.locator("summary").tap();
      await lab
        .getByRole("button", { name: "Svelte connection", exact: true })
        .tap();
      await expect(lab.getByLabel("Actor connection example")).toContainText(
        "useActor",
      );
      const geometry = await lab.evaluate((element) => {
        const client = element
          .querySelector(".svelte-client")!
          .getBoundingClientRect();
        const peers = element
          .querySelector(".actor-dock")!
          .getBoundingClientRect();
        return {
          clientBottom: client.bottom,
          peerTop: peers.top,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(geometry.clientBottom).toBeLessThanOrEqual(geometry.peerTop);
      expect(geometry.overflow).toBe(false);
      for (const button of [
        add,
        client.getByRole("button", { name: "+ Increment", exact: true }),
        client.getByRole("button", { name: "+ Via HTTP", exact: true }),
        client.getByRole("button", {
          name: "Remove counter-01 from playground",
          exact: true,
        }),
      ]) {
        const box = await button.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      await page.screenshot({
        path: `test-results/design-${width}-seven.png`,
        fullPage: true,
      });
      await page.getByRole("link", { name: "Get started", exact: true }).tap();
      await expect(page.locator("#start-title")).toBeInViewport();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/design-${width}-quickstart.png`,
      });
    });
  }
});
