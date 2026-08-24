import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { conversationWithReply } from "./fixtures";

/**
 * A reply whose turn was cut off keeps a mark saying it is still being written.
 * The view hides anything carrying that mark while a turn is live, so the reply
 * vanished for the length of every later generation — most visibly the moment
 * you tried to continue it, which is exactly what you do with one that stopped
 * short.
 */
test("a reply left mid-write stays on screen while it is continued", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/chat/${convo.id}`);

  // A genuinely interrupted reply, made the way one happens: stopped part way
  // through. Setting the mark through the API is not an option — the endpoint
  // does not take it — and faking it would test the fake.
  await page.locator("textarea").first().fill("Keep going.");
  // The button, not Enter: on a touch screen Enter is a newline, deliberately.
  await page.locator('button[title="Send"]').click();
  const stop = page.locator('button[title="Stop generation"]');
  await expect(stop).toBeVisible();
  await page.waitForTimeout(400);
  await stop.click();

  await page.reload();
  await page.waitForLoadState("networkidle");

  const stranded = (await (await request.get(
    `${API}/api/conversations/${convo.id}`)).json()).messages.at(-1);
  expect(stranded.meta.streaming, "the stop did not leave an unfinished reply").toBe(true);

  const onScreen = page.locator(`[data-message-id="${stranded.id}"]`);
  await expect(onScreen).toBeVisible();

  await page.locator('button[title="Continue the reply"]').first().click({ force: true });

  // Through the whole generation, not just at the end of it.
  for (let i = 0; i < 6; i++) {
    await expect(onScreen,
      "the reply disappeared while its continuation was being written").toBeVisible();
    await page.waitForTimeout(250);
  }
});

test("sending a message shows the reply arriving", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/chat/${convo.id}`);

  await page.locator("textarea").first().fill("And then?");
  await page.locator('button[title="Send"]').click();

  await expect(page.getByText("And then?")).toBeVisible();
  // Something has to say the character is answering, or a slow model looks
  // like a broken one.
  await expect(page.locator(".animate-pulse-soft, svg.lucide-square").first()).toBeVisible();
});
