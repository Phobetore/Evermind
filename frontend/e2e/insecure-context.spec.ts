import { expect, test } from "@playwright/test";
import { conversationWithReply } from "./fixtures";

/**
 * The suite's servers listen on this computer's address on the network, so the
 * page is what a phone gets over plain HTTP: the browser withholds a handful of
 * APIs that exist on localhost (crypto.randomUUID, the clipboard).
 */
test.describe("on a page that is not a secure context", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // A machine with no network address has only the loopback, which is secure.
    test.skip(await page.evaluate(() => window.isSecureContext), "no network address");
  });

  test("a lorebook entry can still be added to a new card", async ({ page }) => {
    await page.goto("/#/characters/new");

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
    await page.goto(`/#/chat/${convo.id}`);

    // No hover: on a touch screen the actions are simply always visible, and
    // asking for one there hangs.
    await page.locator('button[title="Copy"]').first().click({ force: true });

    // The tick only appears if the copy came back true, so it stands in for
    // the fallback having run rather than the call having thrown.
    await expect(page.locator("svg.lucide-check").first()).toBeVisible();
  });

  // Copying selects a box of its own. Left there, the focus fell to the page: the row, shown
  // while one of its buttons has it, faded with its tick, and the next Tab began at the top.
  test("copying a message from the keyboard leaves the focus on its button", { tag: "@desktop" }, async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    const reply = page.locator("[data-message-id]").last();
    await reply.getByTitle("Copy", { exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(reply.getByTitle("Copied!", { exact: true })).toBeFocused();
    await expect(reply.locator(".hover-actions")).toHaveCSS("opacity", "1");
  });
});
