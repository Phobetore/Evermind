import { expect, test } from "@playwright/test";
import { conversationWithReply, stopTurn } from "./fixtures";

/** That the path works at all, on every project. What it does when things go wrong
 *  is in the specs that playwright.config.ts runs on the phone. */
test("sending a message shows the reply arriving", async ({ page, request }) => {
  // Slowly, so that the sign of it is still there however long this machine
  // takes to look.
  const convo = await conversationWithReply(request, { slowly: true });
  await page.goto(`/#/chat/${convo.id}`);

  await page.locator("textarea").first().fill("And then?");
  await page.locator('button[title="Send"]').click();

  await expect(page.getByText("And then?")).toBeVisible();
  // Something has to say the character is answering, or a slow model looks
  // like a broken one.
  await expect(page.locator(".animate-pulse-soft, svg.lucide-square").first()).toBeVisible();

  // And then the words. The looking is done, so stopped here rather than left
  // writing into the tests that come next.
  await expect(page.locator(".stream-caret")).toBeVisible();
  await stopTurn(request, convo.id);
});
