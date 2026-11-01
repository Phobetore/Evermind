import { expect, test } from "@playwright/test";
import { makeCharacter } from "./fixtures";

const EXPORT_FAILED = "The card could not be exported.";

/** Exporting is a click that starts a download. When the server cannot make
 *  the file, the page has to say so: a click that does nothing, and says
 *  nothing, looks like a button that is broken. */
test("a card that cannot be exported says so, where the buttons are", async ({ page, request }) => {
  const card = await makeCharacter(request);
  await page.route("**/api/characters/*/export*", (route) =>
    route.fulfill({ status: 500, contentType: "text/html", body: "<h1>Bad gateway</h1>" }),
  );
  await page.goto(`/#/characters/${card.id}/edit`);

  await page.getByRole("button", { name: "JSON" }).click();
  // An alert of its own beside the buttons: the line at the bottom of the form
  // is a screen below them on a phone, and nothing there would have scrolled
  // into view.
  const message = page.getByRole("alert").filter({ hasText: EXPORT_FAILED });
  await expect(message).toBeVisible();
  await expect(message).toBeInViewport();
  // What the server answered is said too, in words and not as a code alone.
  await expect(message).toContainText("HTTP 500");

  // The next try starts clean, and works once the server does.
  await page.unroute("**/api/characters/*/export*");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  await expect(page.getByText(EXPORT_FAILED)).toBeHidden();
});

test("a failed export leaves a save error alone", async ({ page, request }) => {
  const card = await makeCharacter(request);
  await page.goto(`/#/characters/${card.id}/edit`);

  // The save fails for lack of a name, and says so at the bottom of the form.
  await page.getByLabel("Name", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Name is required.")).toBeVisible();

  await page.route("**/api/characters/*/export*", (route) =>
    route.fulfill({ status: 500, contentType: "text/html", body: "<h1>Bad gateway</h1>" }),
  );
  await page.getByRole("button", { name: "PNG" }).click();

  await expect(page.getByRole("alert").filter({ hasText: EXPORT_FAILED })).toBeVisible();
  // Two different problems, each in its own place.
  await expect(page.getByText("Name is required.")).toBeVisible();
});
