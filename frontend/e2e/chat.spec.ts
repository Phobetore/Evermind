import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { conversationWithReply, makeConversation, stopTurn } from "./fixtures";

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

test("a reply that ends while the story is scrolled up leaves it where it is being read", async ({ page, request, isMobile }) => {
  const opening = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of a long opening.`).join("\n\n");
  const convo = await makeConversation(request, { greeting: opening });
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "SLOWLY MOCK_SAYS_back" } });
  await page.goto(`/#/chat/${convo.id}`);
  const story = page.locator("div.overflow-y-auto:has(> div > [data-message-id])");
  await page.locator("textarea").first().fill("Go on.");
  const send = page.getByTitle("Send", { exact: true });
  await (isMobile ? send.tap() : send.click());
  await expect(page.getByTitle("Stop generation")).toBeVisible();

  // Back up to the opening, told at once, or the next word would take the story down again.
  await story.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });

  const reply = page.locator("[data-message-id]").last();
  await expect(reply).toContainText("endback", { timeout: 30_000 });
  await expect(reply.getByTitle("Regenerate")).toBeFocused();
  expect(await story.evaluate((el) => el.scrollTop), "taken down to the reply from what was being read").toBe(0);
});

test("a new conversation is named after its first message, as the server names it", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await page.goto(`/#/chat/${convo.id}`);

  await page.locator("textarea").first().fill("*smiles* hello");
  await page.locator('button[title="Send"]').click();

  const title = page.locator("header button.touch-target");
  await expect(title).toHaveText("hello");
  await stopTurn(request, convo.id);
});
