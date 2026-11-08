import { expect, test } from "@playwright/test";
import { conversationWithReply } from "./fixtures";

/** Every line of the reminder has to be something the app really does, so this
 *  checks the syntax it advertises against what it renders. */
test("the reminder lists syntax the app actually renders", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);

  // On a phone the panel is behind this button; on a laptop it is already open
  // beside the conversation, and the two asides are the nav and the panel.
  // By accessible name: this one carries an aria-label, not a title.
  const opener = page.getByRole("button", { name: /memory and settings/i });
  // By what it holds rather than where it sits: the other aside is the navigation.
  const help = page.locator("aside:visible").filter({ hasText: "*text*" });
  // isVisible() does not wait, and until the conversation has loaded there is
  // neither the button nor the panel: it would answer false, and the button
  // would never be clicked.
  await expect(opener.or(help).first()).toBeVisible();
  if (await opener.isVisible()) await opener.click();
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
