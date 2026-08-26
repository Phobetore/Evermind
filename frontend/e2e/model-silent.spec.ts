import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { conversationWithReply } from "./fixtures";

/**
 * Reported: with the AI server not running, asking for a suggested message did
 * nothing at all — no result and no sign of why. It was in fact being reported,
 * in eleven grey pixels for four seconds, in the slot where the keyboard tip
 * lives. Which is to say: not reported.
 */
/** A conversation with something already in it, then pointed at an address
 *  where nothing is listening — which is what a stopped AI server looks like.
 *  The exchange comes first because asking for a suggestion on an empty
 *  conversation fails for its own reason, and would test that instead. */
async function conversationWithNoModel(request: import("@playwright/test").APIRequestContext) {
  const convo = await conversationWithReply(request);
  const off = await (await request.post(`${API}/api/connections`, {
    data: {
      name: "off", provider: "openai-compatible",
      base_url: "http://127.0.0.1:5999/v1", api_key: "x", model: "absent",
    },
  })).json();
  await request.patch(`${API}/api/conversations/${convo.id}`, {
    data: { connection_id: off.id },
  });
  return convo;
}

test("asking for a suggested message says the model did not answer", async ({ page, request }) => {
  const convo = await conversationWithNoModel(request);
  await page.goto(`/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();

  await page.locator('button[title="Write my reply for me (editable before sending)"]').click();

  const notice = page.getByText(/no answer from the model/i);
  await expect(notice, "nothing said the model had not answered").toBeVisible({ timeout: 20_000 });
  // Still there a while later: a message that fades is one nobody reads.
  await page.waitForTimeout(5_000);
  await expect(notice, "the notice vanished before it could be read").toBeVisible();
  // And not dressed as damage.
  await expect(page.locator("p.text-blood")).toHaveCount(0);
});

test("a reply that never comes says so too", async ({ page, request }) => {
  const convo = await conversationWithNoModel(request);
  await page.goto(`/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();

  await page.locator("textarea").first().fill("Bonjour ?");
  await page.locator('button[title="Send"]').click();

  await expect(page.getByText(/no answer from the model/i)).toBeVisible({ timeout: 30_000 });
  // Once, not twice: one for the reply, and not the leftover from a suggestion.
  await expect(page.getByText(/no answer from the model/i),
    "the notice was on screen twice at once").toHaveCount(1);
  await expect(page.locator("p.text-blood"),
    "a server that is merely off was reported as a fault").toHaveCount(0);
  // The message that was sent is still there to try again from.
  await expect(page.getByText("Bonjour ?")).toBeVisible();
});


test("only one notice at a time", async ({ page, request }) => {
  const convo = await conversationWithNoModel(request);
  await page.goto(`/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();

  await page.locator('button[title="Write my reply for me (editable before sending)"]').click();
  await expect(page.getByText(/no answer from the model/i)).toBeVisible({ timeout: 20_000 });

  await page.locator("textarea").first().fill("Bonjour ?");
  await page.locator('button[title="Send"]').click();
  await expect(page.getByText(/no answer from the model/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/no answer from the model/i),
    "the one from the suggestion stayed while the reply added its own").toHaveCount(1);
});
