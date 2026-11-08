import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { writing } from "./connection";
import { conversationWithReply, stopTurn } from "./fixtures";

/**
 * A regeneration does not show the reply being replaced with its replacement arriving underneath, as
 * though a second reply were being added: not on the page that asked for it, nor on a page that
 * arrives in the middle of it.
 */
// The reply here is deliberately slow, so the window these tests look through is
// wide enough to survive a loaded machine.
test.setTimeout(120_000);

test("the page asking for a regeneration hides the reply being replaced", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  const target = page.locator(`[data-message-id="${convo.messages.at(-1).id}"]`);
  await page.goto(`/#/chat/${convo.id}`);
  await page.waitForLoadState("networkidle");

  await target.getByTitle("Regenerate").click({ force: true });

  await expect(writing(page)).toBeVisible();
  await expect(target, "on screen under its own replacement").toHaveCount(0);
  await stopTurn(request, convo.id);
});

test("a page arriving mid-regeneration hides the reply being replaced", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  const target = convo.messages.at(-1);
  expect(target.role).toBe("assistant");

  // Answered once it is under way: the reply is being written while the page below opens.
  await request.post(`${API}/api/chat`, { data: { conversation_id: convo.id, mode: "regenerate" } });

  await expect.poll(async () =>
    (await (await request.get(`${API}/api/conversations/${convo.id}/turn`)).json()).running,
    { timeout: 10_000 }).toBe(true);

  await page.goto(`/#/chat/${convo.id}`);
  // Not networkidle: attaching holds a stream open, so the network is never
  // idle and the wait runs until it gives up — by which time the turn this test
  // is about has been over for a while.
  await expect(page.locator("textarea").first()).toBeVisible();

  // The reply being replaced must not be on screen while its replacement is
  // being written underneath. Polled against the server's own view of the turn,
  // so a slow machine reads as slow rather than as a pass.
  let everShown = false;
  await expect.poll(async () => {
    const { running } = await (await request.get(
      `${API}/api/conversations/${convo.id}/turn`)).json();
    if (!running) {
      return everShown
        ? "on screen under its own replacement for the whole turn"
        : "the turn ended before the page could be looked at";
    }
    if (await page.locator(`[data-message-id="${target.id}"]`).isVisible()) {
      everShown = true;
      return "on screen under its own replacement";
    }
    return "hidden";
  }, { timeout: 40_000 }).toBe("hidden");

  await stopTurn(request, convo.id);

  // And it replaced rather than appended.
  const after = (await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).messages;
  expect(after.length, "a reply was added instead of replaced").toBe(convo.messages.length);
  expect(after.at(-1).id).toBe(target.id);
  expect(after.at(-1).variants.length).toBe(2);
});
