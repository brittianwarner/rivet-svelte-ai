import { expect, test, type Page } from "@playwright/test";

/**
 * The data browser with two people at once. Each person has their own
 * browser context, so every update below crosses actors and sockets.
 */
async function signIn(page: Page, name: string): Promise<void> {
  await page.goto("/data");
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(
    page.getByRole("complementary", { name: "Data navigation" }),
  ).toContainText(name);
  await expect(page.getByText("Revision")).toBeVisible();
}

test("two people share an organization and watch it change live", async ({
  browser,
}) => {
  const adaContext = await browser.newContext();
  const graceContext = await browser.newContext();
  const ada = await adaContext.newPage();
  const grace = await graceContext.newPage();
  try {
    await signIn(ada, "Ada");
    await signIn(grace, "Grace");

    const orgName = `Engines ${crypto.randomUUID().slice(0, 6)}`;
    await ada.getByLabel("Organization name").fill(orgName);
    await ada.getByRole("button", { name: "Create", exact: true }).click();
    await expect(ada).toHaveURL(/\/data\/orgs\/engines-/);
    await expect(ada.getByRole("heading", { level: 1 })).toHaveText(orgName);
    const nav = ada.getByRole("complementary", { name: "Data navigation" });
    await expect(
      nav.getByRole("link", { name: new RegExp(orgName) }),
    ).toBeVisible();

    // Ada invites Grace. Grace's inbox fills in without a reload.
    await ada.getByLabel("User id").fill("grace");
    await ada.getByRole("button", { name: "Invite", exact: true }).click();
    const invite = grace.locator("li", { hasText: orgName });
    await expect(invite).toBeVisible();
    await invite.getByRole("button", { name: "Accept" }).click();

    // Grace appears in Ada's member table, pushed by the organization actor.
    await expect(ada.getByRole("cell", { name: "Grace grace" })).toBeVisible();
    const graceNav = grace.getByRole("complementary", {
      name: "Data navigation",
    });
    await graceNav.getByRole("link", { name: new RegExp(orgName) }).click();
    await expect(grace.getByRole("heading", { level: 1 })).toHaveText(orgName);

    // Ada starts a project and adds a task; Grace opens it and finishes it.
    await ada.getByRole("link", { name: /^projects/i }).click();
    await ada.getByLabel("Project name").fill("Launch plan");
    await ada.getByRole("button", { name: "New project" }).click();
    await expect(ada).toHaveURL(/\/projects\/launch-plan-/);
    await ada.getByLabel("New task").fill("Draft the notes");
    await ada.getByRole("button", { name: "Add", exact: true }).click();
    const adaTask = ada.getByRole("checkbox", { name: "Draft the notes" });
    await expect(adaTask).not.toBeChecked();

    await grace.getByRole("link", { name: /^projects/i }).click();
    await grace.getByRole("link", { name: /Launch plan/ }).click();
    const graceTask = grace.getByRole("checkbox", { name: "Draft the notes" });
    await graceTask.check();
    await expect(adaTask).toBeChecked();

    // Ada renames the project; Grace's page follows.
    await ada.getByRole("button", { name: "Rename" }).click();
    await ada.getByLabel("Project name").fill("Launch day");
    await ada.getByRole("button", { name: "Save" }).click();
    await expect(grace.getByRole("heading", { level: 1 })).toHaveText(
      "Launch day",
    );

    // Ada removes Grace. Grace's open project page closes her access.
    await ada
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("link", { name: orgName })
      .click();
    await ada
      .getByRole("row", { name: /Grace/ })
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(ada.getByRole("cell", { name: "Grace grace" })).toHaveCount(0);
    await expect(
      graceNav.getByRole("link", { name: new RegExp(orgName) }),
    ).toHaveCount(0);
    await expect(grace.getByRole("alert")).toContainText(
      "You no longer have access to this project.",
    );
  } finally {
    await adaContext.close();
    await graceContext.close();
  }
});

/** Ada creates an organization and Grace joins it. Returns its name. */
async function shareOrganization(ada: Page, grace: Page): Promise<string> {
  const orgName = `Studio ${crypto.randomUUID().slice(0, 6)}`;
  await ada.getByLabel("Organization name").fill(orgName);
  await ada.getByRole("button", { name: "Create", exact: true }).click();
  await expect(ada.getByRole("heading", { level: 1 })).toHaveText(orgName);
  await ada.getByLabel("User id").fill("grace");
  await ada.getByRole("button", { name: "Invite", exact: true }).click();
  const invite = grace.locator("li", { hasText: orgName });
  await invite.getByRole("button", { name: "Accept" }).click();
  await expect(ada.getByRole("cell", { name: "Grace grace" })).toBeVisible();
  return orgName;
}

test("comments, presence, a CSV export, and deleting a project", async ({
  browser,
}) => {
  const adaContext = await browser.newContext({ acceptDownloads: true });
  const graceContext = await browser.newContext();
  const ada = await adaContext.newPage();
  const grace = await graceContext.newPage();
  try {
    await signIn(ada, "Ada");
    await signIn(grace, "Grace");
    const orgName = await shareOrganization(ada, grace);

    await ada.getByRole("link", { name: /^projects/i }).click();
    await ada.getByLabel("Project name").fill("Field notes");
    await ada.getByRole("button", { name: "New project" }).click();
    await expect(ada).toHaveURL(/\/projects\/field-notes-/);
    const projectUrl = ada.url();
    await ada.getByLabel("New task").fill("Write the brief");
    await ada.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      ada.getByRole("checkbox", { name: "Write the brief" }),
    ).toBeVisible();

    // Grace opens the project; Ada sees her in the viewer list.
    await grace.goto(projectUrl);
    await expect(grace.getByRole("heading", { level: 1 })).toHaveText(
      "Field notes",
    );
    await expect(
      ada
        .getByRole("list", { name: "Viewing now" })
        .getByTitle("Grace is viewing"),
    ).toBeVisible();

    // Grace opens the thread first, so Ada's comment arrives as a live event.
    await grace.getByRole("button", { name: "0 comments" }).click();
    await expect(grace.getByText("No comments yet.")).toBeVisible();
    await ada.getByRole("button", { name: "0 comments" }).click();
    await ada.getByLabel("Comment").fill("First pass is up.");
    await ada.getByRole("button", { name: "Post" }).click();
    await expect(grace.getByText("First pass is up.")).toBeVisible();
    await expect(
      grace.getByRole("button", { name: "1 comment" }),
    ).toBeVisible();

    // The export runs as a workflow on its own actor, then downloads.
    await ada.getByRole("button", { name: "Export CSV" }).click();
    const downloadButton = ada.getByRole("button", {
      name: "Download",
      exact: true,
    });
    await expect(downloadButton).toBeVisible();
    const [download] = await Promise.all([
      ada.waitForEvent("download"),
      downloadButton.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^field-notes-.+-tasks\.csv$/);
    const csv = await (await download.createReadStream()).toArray();
    const text = Buffer.concat(csv).toString("utf8");
    expect(text.split("\r\n")[0]).toBe(
      "title,done,created_by,created_at,comments",
    );
    expect(text).toContain("Write the brief,false,ada,");

    // Removing the task reaches Grace live.
    await ada.getByRole("button", { name: "Remove Write the brief" }).click();
    await expect(
      grace.getByRole("checkbox", { name: "Write the brief" }),
    ).toHaveCount(0);

    // Ada deletes the project. Grace's open page reports it gone.
    await ada
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("link", { name: orgName })
      .click();
    await ada.getByRole("link", { name: /^projects/i }).click();
    await ada.getByRole("button", { name: "Delete Field notes" }).click();
    await ada.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(ada.getByText("No projects yet.")).toBeVisible();
    await expect(grace.getByRole("alert")).toContainText(
      "No project has this id.",
    );
  } finally {
    await adaContext.close();
    await graceContext.close();
  }
});

test("a guessed organization id reads as not found", async ({ page }) => {
  await signIn(page, "Linus");
  await page.goto(`/data/orgs/nobody-${crypto.randomUUID().slice(0, 6)}`);
  await expect(page.getByRole("alert")).toContainText(
    "No organization has this id.",
  );
});
