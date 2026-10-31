import { expect, test } from "@playwright/test";
import { makeCharacter } from "./fixtures";

/** Exporting is a click that starts a download. When the server cannot make
 *  the file, the page has to say so: a click that does nothing, and says
 *  nothing, looks like a button that is broken. */
test("a card that cannot be exported says so", async ({ page, request }) => {
  const card = await makeCharacter(request);
  await page.route("**/api/characters/*/export*", (route) =>
    route.fulfill({ status: 500, contentType: "text/html", body: "<h1>Bad gateway</h1>" }),
  );
  await page.goto(`/#/characters/${card.id}/edit`);

  await page.getByRole("button", { name: "JSON" }).click();
  await expect(page.getByText("The card could not be exported.")).toBeVisible();

  // The next try starts clean, and works once the server does.
  await page.unroute("**/api/characters/*/export*");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  await expect(page.getByText("The card could not be exported.")).toBeHidden();
});
