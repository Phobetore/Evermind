import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import {
  connectionDiesDuring, countingPosts, countingStreams, countingTurnQuestions, cutConnection, endingOf,
  expectPickedUp, looseWords, phoneComesBack, retryButton, stopButton, writing,
} from "./connection";
import { conversation, conversationWithReply, stopTurn, turnRunning } from "./fixtures";

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
// erroring. The harsher case, where the request itself rejects because a
// suspended phone's connection died, is further down.
test("a stream cut short still ends with the reply on screen", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);
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

  // The reply finished on the server regardless: what was there, the message
  // just sent, and the answer to it.
  const expected = convo.messages.length + 2;
  await expect.poll(async () =>
    (await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).messages.length,
    { timeout: 40_000 }).toBe(expected);
  // The count is reached with the reply's first word, so it says nothing about
  // the turn being over. The page only hears of the cut after that, and finding
  // no error any sooner than this is finding what was always there.
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 40_000 }).toBe(false);

  await expect(page.locator("[data-message-id]"),
    "the reply never reached the screen without a reload").toHaveCount(expected);
  await expect(page.locator("p.text-blood"),
    "a reply that landed was reported as a failure").toHaveCount(0);
});

test("a message that never reached Evermind is reported", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();

  // Refused outright: no turn ever begins, so the message may not have been
  // sent, and saying nothing would leave someone waiting on a reply that is
  // never coming.
  await page.route("**/api/chat", (route) => route.abort("failed"));
  await page.locator("textarea").first().fill("Personne n'ecoute.");
  await page.locator('button[title="Send"]').click();

  const report = page.locator("p.text-blood").first();
  await expect(report,
    "the message never got through and nothing said so").toBeVisible({ timeout: 20_000 });
  // In words that say what to look at, not the browser's own "Failed to fetch".
  await expect(report).toContainText("Evermind is not answering");
});

test("a connection lost in the middle of a reply is picked back up", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await connectionDiesDuring(page, "api/chat", { chunks: 3 });
  await page.goto(`/#/chat/${convo.id}`);

  const pickedUp = page.waitForRequest("**/turn/stream");
  await page.locator("textarea").first().fill("Coupe.");
  await page.locator('button[title="Send"]').click();
  await expectPickedUp(page, pickedUp);
  // Read from its start again, which must not show anything twice.
  await expect(page.getByText("Coupe."), "the message was added again").toHaveCount(1);

  await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
  const reply = (await conversation(request, convo.id)).messages.at(-1);
  const ending = reply.content.trim().split(" ").slice(-3).join(" ");
  await expect(page.locator(`[data-message-id="${reply.id}"]`),
    "the reply never reached the screen without a reload").toContainText(ending);
  await expect(stopButton(page)).toBeHidden();
  await expect(page.locator("p.text-blood"), "a reply that landed was reported as a failure").toHaveCount(0);
  await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
});

test("a stream that simply ends in the middle of a reply is picked back up", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await connectionDiesDuring(page, "api/chat", { chunks: 3, closes: true });
  await page.goto(`/#/chat/${convo.id}`);

  const pickedUp = page.waitForRequest("**/turn/stream");
  await page.locator("textarea").first().fill("Coupe.");
  await page.locator('button[title="Send"]').click();
  await expectPickedUp(page, pickedUp);

  await stopTurn(request, convo.id);
  await expect(stopButton(page)).toBeHidden();
});

test("a reply that landed while the connection was down is on screen when it returns", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await connectionDiesDuring(page, "api/chat", { chunks: 3 });
  // The connection comes back too late: by the time the page gets an answer about
  // the turn, the turn is over. Opening the page asks too, with nothing running yet.
  await page.route("**/turn", async (route) => {
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
    await route.continue();
  });
  await page.goto(`/#/chat/${convo.id}`);

  await page.locator("textarea").first().fill("Coupe.");
  await page.locator('button[title="Send"]').click();

  await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
    { timeout: 15_000 }).toBe(convo.messages.length + 2);
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
  const reply = (await conversation(request, convo.id)).messages.at(-1);
  const ending = reply.content.trim().split(" ").slice(-3).join(" ");
  await expect(page.locator(`[data-message-id="${reply.id}"]`),
    "the reply never reached the screen without a reload").toContainText(ending);
  await expect(stopButton(page)).toBeHidden();
  await expect(page.locator("p.text-blood"), "a reply that landed was reported as a failure").toHaveCount(0);
});

test("a regeneration whose connection is lost is picked back up, and can be stopped", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await connectionDiesDuring(page, "api/chat", { chunks: 3 });
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();

  const pickedUp = page.waitForRequest("**/turn/stream");
  await page.locator('button[title="Regenerate"]').first().click({ force: true });
  await expectPickedUp(page, pickedUp);

  await stopButton(page).click();
  await expect(stopButton(page)).toBeHidden();
  await expect.poll(() => turnRunning(request, convo.id), {
    message: "the reply kept being written after it was stopped",
  }).toBe(false);
});

test("a page that came back mid-reply and loses its connection picks it back up too", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  // Not awaited: the reply is being written while the page below opens.
  void request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "Ecris.", message_mode: "say" },
    timeout: 120_000,
  }).catch(() => {});
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
  await connectionDiesDuring(page, "api/chat", { chunks: 3, staysDead: true });
  await page.goto(`/#/chat/${convo.id}`);

  await page.locator("textarea").first().fill("Personne.");
  await page.locator('button[title="Send"]').click();

  const report = page.locator("p.text-blood").first();
  await expect(report, "the connection died and nothing said so").toBeVisible({ timeout: 20_000 });
  await expect(report).toContainText("Evermind is not answering");
  await expect(stopButton(page), "still claiming to be receiving a reply").toBeHidden();

  // What had arrived stays, with the report under it.
  await expect(looseWords(page), "the words that had arrived vanished").not.toHaveText("");
  await expect(writing(page), "still drawn as being written").toHaveCount(0);
  const [words, under] = [await looseWords(page).boundingBox(), await report.boundingBox()];
  expect(words!.y, "the report is not below the words").toBeLessThan(under!.y);
  // Retry asks first, where Regenerate on the message would ask for a second reply.
  await expect(page.locator("[data-message-id]", { hasText: "Personne." }).getByTitle("Regenerate"))
    .toHaveCount(0);

  // The server never heard any of this, and is still writing.
  await stopTurn(request, convo.id);
});

/** The connection goes for real, the reply is part way through, and the test holds
 *  it there: words on screen, the report under them, nothing running here. */
async function replyCutOff(page: Page, context: BrowserContext, convoId: string) {
  await connectionDiesDuring(page, "api/chat");
  await page.goto(`/#/chat/${convoId}`);
  await page.locator("textarea").first().fill("Coupe.");
  await page.locator('button[title="Send"]').click();
  await expect(writing(page)).toBeVisible();
  await context.setOffline(true);
  await cutConnection(page);
  const report = page.locator("p.text-blood").first();
  await expect(report).toContainText("Evermind is not answering", { timeout: 20_000 });
  await expect(looseWords(page), "the words that had arrived vanished").not.toHaveText("");
  return { report, kept: (await looseWords(page).textContent()) ?? "" };
}

test("a reply cut off comes back by itself with the connection", async ({ page, context, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  const { report, kept } = await replyCutOff(page, context, convo.id);
  const asks = countingTurnQuestions(page);

  // Still nothing: one quiet attempt for a burst of events, and nothing changes.
  await phoneComesBack(page);
  await phoneComesBack(page);
  await expect.poll(asks).toBe(1);
  await phoneComesBack(page);
  await expect.poll(asks, "more than one attempt for the events that arrived").toBe(2);
  await expect(report).toContainText("Evermind is not answering");
  await expect(looseWords(page)).toHaveText(kept);

  const pickedUp = page.waitForRequest("**/turn/stream");
  await context.setOffline(false);
  await phoneComesBack(page);
  await expectPickedUp(page, pickedUp);
  await expect(report, "the report stayed once the connection was back").toBeHidden();

  await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
  const reply = (await conversation(request, convo.id)).messages.at(-1);
  await expect(page.locator(`[data-message-id="${reply.id}"]`)).toContainText(endingOf(reply.content));
  await expect(page.getByText("Coupe."), "the message was added again").toHaveCount(1);
  await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
});

test("a stream sent from this page that stopped without a word is asked about when the phone comes back", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await connectionDiesDuring(page, "api/chat", { chunks: 3, hangs: true });
  const streams = countingStreams(page);
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Dors.");
  await page.locator('button[title="Send"]').click();
  await expect(writing(page)).toBeVisible();
  const before = streams();

  // Nothing but a phone coming back can notice this. It asks only once no word
  // has arrived for a while, so it is said again until the page has asked.
  await expect.poll(async () => {
    await phoneComesBack(page);
    return streams();
  }, { timeout: 20_000, message: "a silent stream was not asked about" }).toBeGreaterThan(before);
  await expectPickedUp(page, Promise.resolve());

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

test("a reply that failed with no page open is reported on opening, and can be asked for again", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { failing: true });
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "Personne.", message_mode: "say" },
    timeout: 60_000,
  });
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });

  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("p.text-blood").first()).toContainText("The reply did not arrive");
  await expect(stopButton(page)).toBeHidden();

  await retryButton(page).click();
  const expected = convo.messages.length + 2;
  await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
    { timeout: 30_000, message: "no reply was asked for" }).toBe(expected);
  await expect(page.locator("[data-message-id]")).toHaveCount(expected);
  await expect(page.locator("p.text-blood")).toHaveCount(0);
});


test("retrying joins a reply that is still being written", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await connectionDiesDuring(page, "api/chat", { chunks: 3, staysDead: true });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Coupe.");
  await page.locator('button[title="Send"]').click();
  await expect(retryButton(page)).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => (window as unknown as Record<string, () => void>).__connectionBack());
  const posts = countingPosts(page);
  const pickedUp = page.waitForRequest("**/turn/stream");
  await retryButton(page).click();
  await expectPickedUp(page, pickedUp);
  expect(posts(), "asked for another reply while one was being written").toBe(0);

  await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
  const reply = (await conversation(request, convo.id)).messages.at(-1);
  expect(reply.variants.length, "a new variant for nothing").toBe(1);
  await expect(page.locator(`[data-message-id="${reply.id}"]`)).toContainText(endingOf(reply.content));
});

test("retrying sends again a message that never reached Evermind", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.route("**/api/chat", (route) => route.abort("failed"));
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Encore une fois.");
  await page.locator('button[title="Send"]').click();
  await expect(retryButton(page)).toBeVisible({ timeout: 20_000 });
  await page.unroute("**/api/chat");

  await retryButton(page).click();

  await expect(page.getByText("Encore une fois."), "the message was not sent again").toHaveCount(1);
  await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
    { timeout: 30_000 }).toBe(convo.messages.length + 2);
  await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2, { timeout: 30_000 });
});
