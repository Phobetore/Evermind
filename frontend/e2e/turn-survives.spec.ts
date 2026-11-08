import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { conversation, conversationWithReply, stopTurn, turnRunning } from "./fixtures";

/**
 * A reply belongs to the server: a tab closing or a screen locking, constant on a phone, does not
 * end it.
 *
 * The first two tests look at a reply after its page has gone, so they ask for a slow one: closing a
 * context is when Playwright takes the screenshot it keeps in case of a failure, which can take five
 * seconds on a loaded CI runner at a phone's resolution. And they wait for the first words before
 * the page goes, not only for the stop button, which is there before the request has reached anybody.
 */
// A slow reply, in the first test waited for to the end.
test.setTimeout(120_000);

test("the reply keeps being written after the page goes away", async ({ browser, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/#/chat/${convo.id}`);

  await page.locator("textarea").first().fill("Continue, je pars.");
  await page.locator('button[title="Send"]').click();
  await expect(page.locator('button[title="Stop generation"]')).toBeVisible();
  await expect(page.locator(".stream-caret")).toBeVisible();

  // The phone goes to sleep.
  await context.close();

  // The server was asked, not the page, so the turn is still going.
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 5_000 }).toBe(true);

  await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);

  const messages = (await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).messages;
  const reply = messages.at(-1);
  expect(reply.role).toBe("assistant");
  expect(reply.meta.interrupted, "left unfinished, so the generation died with the page").toBeUndefined();
  expect(reply.content.length).toBeGreaterThan(40);
});

test("coming back shows the reply still arriving", async ({ browser, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  const first = await browser.newContext();
  const page = await first.newPage();
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Ecris longuement.");
  await page.locator('button[title="Send"]').click();
  await expect(page.locator('button[title="Stop generation"]')).toBeVisible();
  await expect(page.locator(".stream-caret")).toBeVisible();
  await first.close();

  // Somebody opens the conversation again while it is still being written.
  const second = await browser.newContext();
  const back = await second.newPage();
  await back.goto(`/#/chat/${convo.id}`);
  // Polled against the server's own view of the turn, so that a machine too slow
  // to get here in time says that, rather than accusing the page.
  await expect.poll(async () => {
    if (await back.locator('button[title="Stop generation"]').isVisible()) return "still arriving";
    return await turnRunning(request, convo.id)
      ? "the conversation looked finished while a reply was still being written"
      : "the reply was over before the page got here, so this looked at nothing";
  }, { timeout: 10_000 }).toBe("still arriving");

  await second.close();
  await stopTurn(request, convo.id);
});

/** A page opening asks whether a reply is being written, reads the conversation, then follows the words. */
test("a reply ending while the page follows it is shown whole", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "Ecris longuement.", message_mode: "say" },
  });

  // Some of it has landed, so that what the page reads below is unfinished.
  await expect.poll(async () => (await conversation(request, convo.id)).messages.at(-1).role,
    { timeout: 10_000 }).toBe("assistant");

  // The order this is about, forced: what it follows only answers once nothing is running.
  await page.route("**/turn/stream", async (route) => {
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
    await route.continue();
  });
  const firstRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/conversations/${convo.id}`);
  await page.goto(`/#/chat/${convo.id}`);
  const seen = (await (await firstRead).json()).messages.at(-1);

  await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
  const reply = (await conversation(request, convo.id)).messages.at(-1);
  expect(seen.content.length, "the page did not read the reply unfinished")
    .toBeLessThan(reply.content.length);

  const ending = reply.content.trim().split(" ").slice(-3).join(" ");
  await expect(page.locator(`[data-message-id="${reply.id}"]`),
    "the reply stayed as far as it had got when the page read it").toContainText(ending);
  await expect(page.locator('button[title="Stop generation"]')).toBeHidden();
});

/** A reply cut short keeps a mark saying so, and while a turn is live the view draws the message it
 *  writes from its words as they arrive. */
test("a reply left mid-write stays on screen while it is continued", async ({ page, request }) => {
  // Slowly, so the reply is still being written when it is stopped however fast
  // this machine is.
  const convo = await conversationWithReply(request, { slowly: true });
  await page.goto(`/#/chat/${convo.id}`);

  // A genuinely interrupted reply, made the way one happens: stopped part way
  // through. Setting the mark through the API is not an option — the endpoint
  // does not take it — and faking it would test the fake.
  await page.locator("textarea").first().fill("Keep going.");
  // The button, not Enter: on a touch screen Enter is a newline, deliberately.
  await page.locator('button[title="Send"]').click();
  const stop = page.locator('button[title="Stop generation"]');
  await expect(stop).toBeVisible();
  // Stopped once some of the reply has arrived, not after a delay: a stop before
  // the first word leaves nothing written to be unfinished, and a stop after the
  // last leaves a finished reply. The caret is only there while text is streaming.
  await expect(page.locator(".stream-caret")).toBeVisible();
  await stop.click();
  // Over on the server's account before the page goes: a reload can overtake the
  // stop, and a page reloaded sooner attaches to what is left of the turn.
  await expect.poll(() => turnRunning(request, convo.id), {
    message: "the reply kept being written after it was stopped",
  }).toBe(false);

  await page.reload();
  await page.waitForLoadState("networkidle");

  const stranded = (await (await request.get(
    `${API}/api/conversations/${convo.id}`)).json()).messages.at(-1);
  expect(stranded.meta.interrupted, "the stop did not leave a reply cut short").toEqual([0]);

  await expect(page.locator(`[data-message-id="${stranded.id}"]`)).toBeVisible();
  const words = stranded.content.replaceAll("*", "").split(" ").slice(0, 4).join(" ");

  await page.locator('button[title="Continue the reply"]').first().click({ force: true });

  // Through the generation, not just at the end of it: looked at again with each
  // new word, however long those take to come here.
  const writing = page.locator(".stream-caret");
  await expect(writing).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await expect(page.locator("main"),
      "the reply disappeared while its continuation was being written").toContainText(words);
    await expect(writing).not.toHaveText((await writing.textContent()) ?? "");
  }

  // The continuation is slow and the looking is done. Stopped here, and waited
  // for on the server's own account of the turn, so it is not still writing
  // into the tests that come next.
  await stop.click();
  await expect(stop).toBeHidden();
  await expect.poll(() => turnRunning(request, convo.id),
    { message: "the continuation kept running after it was stopped" }).toBe(false);
});
