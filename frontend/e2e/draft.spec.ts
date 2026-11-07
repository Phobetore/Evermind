import { expect, test } from "@playwright/test";
import { makeConversation } from "./fixtures";

/** A half-written message is kept in the browser, per conversation, and comes
 *  back when the page does: the phone's browser reloads a tab it had to free
 *  memory from, and what was typed must not go with it. */
test("an unsent message is still there when the page comes back", async ({ page, request }) => {
  const first = await makeConversation(request);
  const second = await makeConversation(request);
  await page.goto(`/#/chat/${first.id}`);

  // Kept as it is typed: the page can be gone the moment after.
  await page.locator("textarea").first().fill("I was about to say");

  await page.reload();
  await expect(page.locator("textarea").first()).toHaveValue("I was about to say");
  await expect(page.getByText("Draft restored")).toBeVisible();

  // The draft belongs to its conversation.
  await page.goto(`/#/chat/${second.id}`);
  await expect(page.locator("textarea").first()).toHaveValue("");
  await page.goto(`/#/chat/${first.id}`);
  await expect(page.locator("textarea").first()).toHaveValue("I was about to say");
});

test("the notice about a restored draft goes away by itself", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Hold on");

  await page.reload();
  await expect(page.getByText("Draft restored")).toBeVisible();
  await expect(page.getByText("Draft restored")).toBeHidden({ timeout: 8000 });
  await expect(page.locator("textarea").first()).toHaveValue("Hold on");
});
