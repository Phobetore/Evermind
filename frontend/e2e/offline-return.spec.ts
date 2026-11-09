import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import {
  connectionDiesDuring, countingPosts, countingStreams, cutConnection, endingOf,
  expectPickedUp, looseWords, phoneComesBack, retryButton, stopButton, writing,
} from "./connection";
import { chat, conversation, conversationWithReply, stopTurn, turnRunning } from "./fixtures";

/**
 * The server answers as soon as it has the message, and the reply is its own from
 * then on: a page follows it, and whatever breaks that is only a reason to ask the
 * server again how it stands. A message the server never had stays in the box.
 */
// What this one covers is the stream ending early — cut short rather than
// erroring. The harsher case, where the request itself rejects because a
// suspended phone's connection died, is further down.
test("a stream cut short still ends with the reply on screen", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();

  // Let the request through, then cut the stream once its first words are there.
  // Playwright's offline mode leaves an established connection alone, so it
  // cannot produce this on its own.
  await page.route("**/turn/stream", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const upTo = body.indexOf('"delta"');
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: body.slice(0, upTo > 0 ? body.indexOf("\n\n", upTo) + 2 : body.indexOf("\n\n") + 2),
    });
  });

  await page.locator("textarea").first().fill("Reponds-moi.");
  await page.locator('button[title="Send"]').click();

  // The reply finished on the server regardless: what was there, the message
  // just sent, and the answer to it.
  const expected = convo.messages.length + 2;
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 40_000 }).toBe(false);
  expect((await conversation(request, convo.id)).messages.length).toBe(expected);

  await expect(page.locator("[data-message-id]"),
    "the reply never reached the screen without a reload").toHaveCount(expected);
  await expect(page.locator("p.text-blood"),
    "a reply that landed was reported as a failure").toHaveCount(0);
});

test("a message that never reached Evermind is reported, and stays to be sent again", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();

  // Refused outright: the server never had it, and saying nothing would leave
  // someone waiting on a reply that is never coming.
  await page.route("**/api/chat", (route) => route.abort("failed"));
  await page.locator("textarea").first().fill("Encore une fois.");
  await page.locator('button[title="Send"]').click();

  const report = page.locator("p.text-blood").first();
  await expect(report,
    "the message never got through and nothing said so").toBeVisible({ timeout: 20_000 });
  // In words that say what to do, not the browser's own "Failed to fetch": Evermind answers,
  // and does not have it.
  await expect(report).toContainText("This message was not sent");
  await expect(page.locator("textarea").first()).toHaveValue("Encore une fois.");
  await expect(retryButton(page), "Send is what sends it").toHaveCount(0);
  await page.unroute("**/api/chat");

  await page.locator('button[title="Send"]').click();

  await expect(page.getByText("Encore une fois."), "the message was not sent again").toHaveCount(1);
  await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
    { timeout: 30_000 }).toBe(convo.messages.length + 2);
  await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2, { timeout: 30_000 });
});

/** A reply the page is reading, whose stream breaks in the way given, after three pieces. */
async function streamBreaks(page: Page, id: string, trouble: { closes?: boolean } = {}) {
  await connectionDiesDuring(page, "/turn/stream", { chunks: 3, ...trouble });
  const streams = countingStreams(page);
  await page.goto(`/#/chat/${id}`);
  await page.locator("textarea").first().fill("Coupe.");
  await page.locator('button[title="Send"]').click();
  await expectPickedUp(page, expect.poll(streams, { timeout: 15_000 }).toBeGreaterThan(1));
}

test("a connection lost in the middle of a reply is picked back up", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true, says: "halfway" });
  await streamBreaks(page, convo.id);
  // Read from where it stands again, which must not show anything twice.
  await expect(page.getByText("Coupe."), "the message was added again").toHaveCount(1);

  await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
  const reply = (await conversation(request, convo.id)).messages.at(-1);
  await expect(page.locator(`[data-message-id="${reply.id}"]`),
    "the reply never reached the screen without a reload").toContainText(endingOf(reply.content));
  await expect(stopButton(page)).toBeHidden();
  await expect(page.locator("p.text-blood"), "a reply that landed was reported as a failure").toHaveCount(0);
  await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
});

test("a stream that simply ends in the middle of a reply is picked back up", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await streamBreaks(page, convo.id, { closes: true });

  await stopTurn(request, convo.id);
  await expect(stopButton(page)).toBeHidden();
});

test("a reply that landed while its stream was down is on screen when it returns", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await connectionDiesDuring(page, "/turn/stream", { chunks: 3 });
  // The page asks how things stand only once the turn is over: it comes back to an ending.
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  await page.route("**/turn", async (route) => {
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
    await route.continue();
  });

  await page.locator("textarea").first().fill("Coupe.");
  await page.locator('button[title="Send"]').click();

  await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
    { timeout: 15_000 }).toBe(convo.messages.length + 2);
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
  const reply = (await conversation(request, convo.id)).messages.at(-1);
  await expect(page.locator(`[data-message-id="${reply.id}"]`),
    "the reply never reached the screen without a reload").toContainText(endingOf(reply.content));
  await expect(stopButton(page)).toBeHidden();
  await expect(page.locator("p.text-blood"), "a reply that landed was reported as a failure").toHaveCount(0);
});

test("a regeneration whose stream is lost is picked back up, and can be stopped", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await connectionDiesDuring(page, "/turn/stream", { chunks: 3 });
  const streams = countingStreams(page);
  await page.goto(`/#/chat/${convo.id}`);
  await page.waitForLoadState("networkidle");

  await page.locator('button[title="Regenerate"]').first().click({ force: true });
  await expectPickedUp(page, expect.poll(streams, { timeout: 15_000 }).toBeGreaterThan(1));

  await stopButton(page).click();
  await expect(stopButton(page)).toBeHidden();
  await expect.poll(() => turnRunning(request, convo.id), {
    message: "the reply kept being written after it was stopped",
  }).toBe(false);
});

test("a page that came back mid-reply and loses its connection picks it back up too", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  // Not waited for: the reply is being written while the page below opens.
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "Ecris.", message_mode: "say" },
  });
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 10_000 }).toBe(true);

  await connectionDiesDuring(page, "/turn/stream", { chunks: 3 });
  const streams: string[] = [];
  page.on("request", (sent) => { if (sent.url().endsWith("/turn/stream")) streams.push(sent.url()); });
  await page.goto(`/#/chat/${convo.id}`);
  await expect.poll(() => streams.length, { timeout: 15_000 }).toBe(2);
  await expectPickedUp(page, Promise.resolve());

  await stopTurn(request, convo.id);
});

test("a connection that stays dead is reported rather than left silent", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await connectionDiesDuring(page, "/turn/stream", { chunks: 3, staysDead: true });
  await page.goto(`/#/chat/${convo.id}`);

  await page.locator("textarea").first().fill("Personne.");
  await page.locator('button[title="Send"]').click();

  const report = page.locator("p.text-blood").first();
  await expect(report, "the connection died and nothing said so").toBeVisible({ timeout: 20_000 });
  await expect(report).toContainText("Evermind is not answering");
  await expect(stopButton(page), "a stop that cannot be said is offered").toBeHidden();

  // What had arrived stays, with the report under it.
  await expect(looseWords(page), "the words that had arrived vanished").not.toHaveText("");
  await expect(writing(page), "still drawn as being written").toHaveCount(0);
  const [words, under] = [await looseWords(page).boundingBox(), await report.boundingBox()];
  expect(words!.y, "the report is not below the words").toBeLessThan(under!.y);
  // Nothing on the message asks for a second reply while the first may still be written.
  await expect(page.locator("[data-message-id]", { hasText: "Personne." }).getByTitle("Regenerate"))
    .toHaveCount(0);

  // The server never heard any of this, and is still writing.
  await stopTurn(request, convo.id);
});

/** The connection goes for real, the reply is part way through, and the test holds
 *  it there: words on screen, the report under them, nothing running here. */
async function replyCutOff(page: Page, context: BrowserContext, convoId: string) {
  await connectionDiesDuring(page, "/turn/stream");
  await page.goto(`/#/chat/${convoId}`);
  await page.locator("textarea").first().fill("Coupe.");
  await page.locator('button[title="Send"]').click();
  await expect(writing(page)).toBeVisible();
  await context.setOffline(true);
  await cutConnection(page);
  const report = page.locator("p.text-blood").first();
  await expect(report).toContainText("This device is offline", { timeout: 20_000 });
  await expect(looseWords(page), "the words that had arrived vanished").not.toHaveText("");
  return { report, kept: (await looseWords(page).textContent()) ?? "" };
}

test("a reply cut off comes back by itself with the connection", async ({ page, context, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  const { report, kept } = await replyCutOff(page, context, convo.id);

  // Still nothing, however often the phone says it is back: the words stay as they were.
  await phoneComesBack(page);
  await expect(report).toContainText("This device is offline");
  await expect(looseWords(page)).toHaveText(kept);

  const streams = countingStreams(page);
  await context.setOffline(false);
  await expectPickedUp(page, expect.poll(streams, { timeout: 15_000 }).toBeGreaterThan(0));
  await expect(report, "the report stayed once the connection was back").toBeHidden();

  await stopTurn(request, convo.id);
  const reply = (await conversation(request, convo.id)).messages.at(-1);
  await expect(page.locator(`[data-message-id="${reply.id}"]`)).toContainText(endingOf(reply.content));
  await expect(page.getByText("Coupe."), "the message was added again").toHaveCount(1);
  await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
});

test("a stream that stopped without a word is asked about when the phone comes back", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await connectionDiesDuring(page, "/turn/stream", { chunks: 3, hangs: true });
  const streams = countingStreams(page);
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Dors.");
  await page.locator('button[title="Send"]').click();
  await expect(writing(page)).toBeVisible();
  const before = streams();

  // Nothing but a phone coming back can notice this.
  await phoneComesBack(page);
  await expectPickedUp(page, expect.poll(streams, { timeout: 20_000 }).toBeGreaterThan(before));

  await stopTurn(request, convo.id);
  await expect(stopButton(page)).toBeHidden();
});

test("a phone coming back does not disturb a reply that is arriving", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Vas-y.");
  await page.locator('button[title="Send"]').click();
  await expect(writing(page)).toBeVisible();

  await phoneComesBack(page);
  // Two more words, which is longer than the page waits before acting on that.
  for (let word = 0; word < 2; word++) {
    await expect(writing(page)).not.toHaveText((await writing(page).textContent()) ?? "");
  }

  await stopTurn(request, convo.id);
});

test("a reply that failed with no page open is reported on opening with its reason, and can be asked for again", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { failing: true });
  await chat(request, { conversation_id: convo.id, mode: "send", content: "Personne." });
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });

  const posts = countingPosts(page);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("p.text-blood").first()).toContainText("told to fail");
  await expect(stopButton(page)).toBeHidden();

  await retryButton(page).click();
  const expected = convo.messages.length + 2;
  await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
    { timeout: 30_000, message: "no reply was asked for" }).toBe(expected);
  await expect(page.locator("[data-message-id]")).toHaveCount(expected);
  await expect(page.locator("p.text-blood")).toHaveCount(0);
  expect(posts()).toBe(1);
});
