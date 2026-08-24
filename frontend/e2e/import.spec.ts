import { expect, test } from "@playwright/test";
import { makeCharacter } from "./fixtures";

/** Import used to open the system file picker on the spot, which assumes you
 *  already know what Evermind takes. */
test("Import explains itself before asking for a file", async ({ page, request }) => {
  await makeCharacter(request);
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  let pickerOpened = false;
  page.on("filechooser", () => { pickerOpened = true; });

  // By title: the label is hidden on a phone, where only the icon is left.
  await page.getByTitle(/^import a card/i).click();

  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  expect(pickerOpened, "the file picker opened instead of the window").toBe(false);
  await expect(dialog).toContainText(/png/i);
  await expect(dialog).toContainText(/lorebook/i);
  await expect(dialog.getByRole("button", { name: /drop a card/i })).toBeVisible();
});
