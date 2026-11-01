import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { conversationWithReply, stopTurn, turnRunning } from "./fixtures";

/**
 * A reply whose turn was cut off keeps a mark saying it is still being written,
 * and while a turn is live the view hides the reply that turn is writing. Taken
 * for that one, the reply left marked vanished for the length of every later
 * generation — most visibly the moment you tried to continue it, which is
 * exactly what you do with one that stopped short.
 */
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
  expect(stranded.meta.streaming, "the stop did not leave an unfinished reply").toBe(true);

  const onScreen = page.locator(`[data-message-id="${stranded.id}"]`);
  await expect(onScreen).toBeVisible();

  await page.locator('button[title="Continue the reply"]').first().click({ force: true });

  // Through the generation, not just at the end of it: looked at again with each
  // new word, however long those take to come here.
  const writing = page.locator(".stream-caret");
  await expect(writing).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await expect(onScreen,
      "the reply disappeared while its continuation was being written").toBeVisible();
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
