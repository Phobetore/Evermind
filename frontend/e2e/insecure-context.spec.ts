import { expect, test } from "@playwright/test";
import { conversationWithReply } from "./fixtures";

/**
 * Reached over a network by address — http://192.168.1.20:3000, the way anyone
 * running Evermind on one machine and using it from another does — the browser
 * withholds a handful of APIs that exist on localhost. Two of them were being
 * called, and both threw.
 *
 * The APIs are removed here rather than the app being served from a real
 * address: the failure is what a missing API does to the code, and a test that
 * needed a routable IP would fail on whichever machine did not have one.
 */
test.describe("without the APIs a secure context provides", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // On the prototype, not on the instance: deleting window.crypto.randomUUID
      // removes nothing and leaves the API exactly where it was, which is a
      // very quiet way for this whole file to test nothing at all.
      delete (Crypto.prototype as unknown as Record<string, unknown>).randomUUID;
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    });

    // Cheap, and the alternative is a suite that passes because the thing it
    // meant to take away is still there.
    await page.addInitScript(() => {
      if (typeof crypto.randomUUID === "function") {
        throw new Error("crypto.randomUUID is still present: the test is not testing anything");
      }
    });
  });

  test("a lorebook entry can still be added to a new card", async ({ page }) => {
    // A new card, not an existing one: on a card already saved the server
    // hands out the identifier, and the call that fails is never reached.
    await page.goto("/characters/new");

    const box = page.locator("div.border-dashed").last();
    await box.scrollIntoViewIfNeeded();
    await box.locator("input").first().click();
    await page.keyboard.type("obsidian throne");
    await page.keyboard.press("Enter");
    await box.locator("textarea").fill("The throne burns anyone not of the bloodline.");
    await page.getByRole("button", { name: /add entry/i }).click();

    // Building the entry needed an identifier, and asking for one is what threw.
    await expect(page.getByText(/no entries yet/i)).toBeHidden();
    await expect(page.getByText("obsidian throne")).toBeVisible();
    await expect(page.getByText(/crypto\.randomUUID/)).toHaveCount(0);
  });

  test("copying a message still reports that it worked", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/chat/${convo.id}`);

    // No hover: on a touch screen the actions are simply always visible, and
    // asking for one there hangs.
    await page.locator('button[title="Copy"]').first().click({ force: true });

    // The tick only appears if the copy came back true, so it stands in for
    // the fallback having run rather than the call having thrown.
    await expect(page.locator("svg.lucide-check").first()).toBeVisible();
  });
});
