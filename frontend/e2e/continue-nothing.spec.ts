import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { conversationWithReply } from "./fixtures";

/**
 * Continue on a reply that the model has nothing to add to. The reply comes back as
 * it was, which looks the same as a button that did nothing, so the page says so.
 */
test("a Continue that adds nothing says the model had nothing to add", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { silent: true });
  const before = convo.messages.at(-1);
  await page.goto(`/#/chat/${convo.id}`);
  const reply = page.locator(`[data-message-id="${before.id}"]`);
  await expect(reply).toBeVisible();
  // Once the page has settled: a name arriving moves the button from under a click.
  await page.waitForLoadState("networkidle");

  await reply.locator('button[title="Continue the reply"]').click({ force: true });

  await expect(page.getByText("The model had nothing to add to this reply.")).toBeVisible();
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.messages.at(-1).variants).toEqual(before.variants);
});
