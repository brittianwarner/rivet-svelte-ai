import { expect, test } from "@playwright/test";

for (const failure of ["denied", "quota"] as const) {
  test(`playground works when browser storage is ${failure}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((mode) => {
      if (mode === "denied") {
        Object.defineProperty(window, "localStorage", {
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
    await expect(
      page.getByRole("button", { name: "+ Increment", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByLabel("Connected actors", { exact: true }),
    ).toHaveText("1");
    await page.getByRole("button", { name: "Add actor", exact: true }).click();
    await expect(
      page.getByLabel("Connected actors", { exact: true }),
    ).toHaveText("2");
    expect(errors).toEqual([]);
  });
}
