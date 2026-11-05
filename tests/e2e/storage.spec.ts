import { expect, test } from "@playwright/test";

for (const failure of ["denied", "quota"] as const) {
  test(`playground and new chat work when session storage is ${failure}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((mode) => {
      if (mode === "denied") {
        Object.defineProperty(window, "sessionStorage", {
          get() {
            throw new DOMException("Storage denied", "SecurityError");
          },
        });
      } else {
        Storage.prototype.setItem = () => {
          throw new DOMException("Storage full", "QuotaExceededError");
        };
      }
    }, failure);
    await page.goto("/");
    const counter = page.getByRole("region", { name: "The realtime counter." });
    await expect(
      counter.getByRole("button", { name: "+ Increment", exact: true }),
    ).toBeEnabled();
    const chat = page.getByRole("region", {
      name: "A conversation with memory.",
    });
    await expect(chat.locator(".connection-badge")).toHaveText("connected");
    await chat.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(chat.locator(".connection-badge")).toHaveText("connected");
    await expect(
      counter.getByRole("button", { name: "+ Increment", exact: true }),
    ).toBeEnabled();
    expect(errors).toEqual([]);
  });
}
