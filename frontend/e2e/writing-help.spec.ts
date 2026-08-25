import { expect, test } from "@playwright/test";
import { conversationWithReply } from "./fixtures";

/** Every line of the reminder has to be something the app really does, so this
 *  checks the syntax it advertises against what it renders. */
test("the reminder lists syntax the app actually renders", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/chat/${convo.id}`);
  // Before this, isVisible() answers about a page that has not hydrated yet:
  // false, and the button below never gets clicked.
  await page.waitForLoadState("networkidle");

  // On a phone the panel is behind this button; on a laptop it is already open
  // beside the conversation, and the two asides are the nav and the panel.
  // By accessible name: this one carries an aria-label, not a title.
  const opener = page.getByRole("button", { name: /memory and settings/i });
  if (await opener.isVisible()) await opener.click();
  // Visible, and by what it holds rather than where it sits. The laptop panel
  // stays in the page on a phone, hidden by CSS, so matching on content alone
  // finds that one and then waits forever for it to appear.
  const help = page.locator("aside:visible").filter({ hasText: "*text*" });
  await expect(help).toBeVisible();
  await expect(help).toContainText("*text*");
  await expect(help).toContainText("**text**");
  await expect(help).toContainText("> text");

  // And the claim itself: asterisks come out italic. The panel covers the whole
  // screen on a phone, so it has to get out of the way of the text box first.
  const close = help.getByRole("button", { name: /close/i });
  if (await close.isVisible()) await close.click();
  await page.locator("textarea").first().fill("*je hausse les epaules*");
  await page.locator('button[title="Send"]').click();
  await expect(page.locator("em", { hasText: "je hausse les epaules" }).first()).toBeVisible();
});
