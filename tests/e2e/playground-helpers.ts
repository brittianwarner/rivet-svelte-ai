import type { Locator, Page } from "@playwright/test";

export async function openKeySettings(scope: Page | Locator): Promise<void> {
  const details = scope.locator(".connection-settings");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
}
