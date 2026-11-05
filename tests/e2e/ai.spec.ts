import { expect, test } from "@playwright/test";

test("AI streams, survives reload and isolates a new conversation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const chat = page.getByRole("region", {
    name: "A conversation with memory.",
  });
  await page.getByLabel("Message", { exact: true }).fill("Say hello");
  await page.getByRole("button", { name: "Send message" }).click();
  const transcript = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  await expect(transcript).toContainText("Hello");
  await page.reload();
  await expect(transcript).toContainText("Hello from the local model.");
  await expect(chat.getByRole("status")).toHaveText(
    "Ready for your next thought.",
  );
  await page.reload();
  await expect(transcript).toContainText("Hello from the local model.");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(transcript).not.toContainText("Say hello");
  await expect(transcript).toContainText("A little state goes a long way.");
  expect(errors).toEqual([]);
});

test("Stop preserves partial output and provider errors allow the next turn", async ({
  page,
}) => {
  await page.goto("/");
  const chat = page.getByRole("region", {
    name: "A conversation with memory.",
  });
  const transcript = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  await page.getByLabel("Message", { exact: true }).fill("[slow]");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(transcript).toContainText("Partial reply");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(chat.getByRole("status")).toHaveText(
    "Ready for your next thought.",
  );
  await expect(transcript).toContainText("Partial reply");
  await page.getByLabel("Message", { exact: true }).fill("[fail]");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(chat.getByRole("alert")).toContainText("model request failed");
  await page.getByLabel("Message", { exact: true }).fill("Try again");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(transcript).toContainText("Hello from the local model.");
  await expect(chat.getByRole("alert")).toHaveCount(0);
});
