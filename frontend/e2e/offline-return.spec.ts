import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { conversationWithReply } from "./fixtures";

/**
 * Reported: close the tab, leave it a while, come back, and there is an error
 * to dismiss by reloading before the reply shows up. The reply had landed
 * perfectly well — the page had a request that failed while it was away and no
 * way to tell that from Evermind being gone.
 *
 * What decides it is whether the turn ever began. The `start` event is how the
 * page knows; after it, the reply belongs to the server and finishes without
 * anyone watching, so a broken connection is nothing to report. Before it, the
 * message may never have been sent, which is.
 */
// What this one covers is the stream ending early — cut short rather than
// erroring. The reported case is the harsher one, where the request itself
// rejects because a suspended phone's connection died, and Playwright cannot
// produce that: fulfilling a route always ends the body cleanly, and its
// offline mode leaves an established connection alone. The decision both share
// is the same, and the test below covers its other side.
test("a stream cut short still ends with the reply on screen", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();

  // Let the request through, then cut the stream once the turn is under way.
  // Playwright's offline mode leaves an established connection alone, so it
  // cannot produce this on its own.
  await page.route("**/api/chat", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const upTo = body.indexOf('"delta"');
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: body.slice(0, upTo > 0 ? body.indexOf("\n\n", upTo) + 2 : body.length),
    });
  });

  await page.locator("textarea").first().fill("Reponds-moi.");
  await page.locator('button[title="Send"]').click();

  // The reply finished on the server regardless.
  await expect.poll(async () =>
    (await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).messages.length,
    { timeout: 40_000 }).toBe(4);

  await expect(page.locator("p.text-blood"),
    "a reply that landed was reported as a failure").toHaveCount(0);
  await expect(page.locator("[data-message-id]"),
    "the reply never reached the screen without a reload").toHaveCount(4);
});

test("a message that never reached Evermind is reported", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();

  // Refused outright: no turn ever begins, so the message may not have been
  // sent, and saying nothing would leave someone waiting on a reply that is
  // never coming.
  await page.route("**/api/chat", (route) => route.abort("failed"));
  await page.locator("textarea").first().fill("Personne n'ecoute.");
  await page.locator('button[title="Send"]').click();

  await expect(page.locator("p.text-blood").first(),
    "the message never got through and nothing said so").toBeVisible({ timeout: 20_000 });
});
