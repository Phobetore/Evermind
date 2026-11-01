import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { conversation, conversationWithReply, makeConversation, stopTurn, turnRunning } from "./fixtures";

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

/**
 * What a phone going to sleep does to a reply being read: the request rejects part
 * way through the answer, and the server, whose turn it is, carries on. Routing
 * cannot produce that (fulfilling a route always ends the body cleanly, and
 * offline mode leaves an established connection alone), so it is `fetch` in the
 * page that is replaced, for the first request to `path`.
 *
 * After `chunks` chunks of the answer it fails, or when the test calls
 * `window.__cutConnection()` if there is no such number. With `staysDead`, nothing
 * gets through afterwards until `window.__connectionBack()`. With `hangs` it fails
 * in another way a stream can: no error, no end, just nothing more. With `closes`,
 * in the third: it ends cleanly, as when something in between gives up on it.
 */
type ConnectionTrouble = { chunks?: number; staysDead?: boolean; hangs?: boolean; closes?: boolean };

async function connectionDiesDuring(page: Page, path: string, trouble: ConnectionTrouble = {}) {
  const options = {
    chunks: null as number | null, staysDead: false, hangs: false, closes: false, ...trouble,
  };
  await page.addInitScript(({ path, chunks, staysDead, hangs, closes }) => {
    const realFetch = window.fetch;
    const page_ = window as unknown as Record<string, () => void>;
    let cut = false;
    let dead = false;
    let cutNow = () => {};
    const asked = new Promise<"cut">((resolve) => { cutNow = () => resolve("cut"); });
    page_.__cutConnection = () => cutNow();
    page_.__connectionBack = () => { dead = false; };
    window.fetch = async (input, init) => {
      if (dead) throw new TypeError("Failed to fetch");
      const response = await realFetch(input, init);
      if (cut || !String(input).endsWith(path) || !response.body) return response;
      cut = true;
      const reader = response.body.getReader();
      let passed = 0;
      const body = new ReadableStream({
        async pull(controller) {
          const next = chunks !== null && passed++ >= chunks
            ? "cut" as const
            : await Promise.race([reader.read(), asked]);
          if (next !== "cut") {
            if (next.done) controller.close();
            else controller.enqueue(next.value);
            return;
          }
          if (hangs) return new Promise<void>(() => {});
          dead = staysDead;
          await reader.cancel();
          if (closes) controller.close();
          else controller.error(new TypeError("network error"));
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };
  }, { path, ...options });
}

/** Says what a phone coming back says, and lets the page's short wait go by. */
async function phoneComesBack(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

const stopButton = (page: Page) => page.locator('button[title="Stop generation"]');
/** The words of a reply outside the messages: arriving, or kept after being cut off. */
const looseWords = (page: Page) => page.locator("main .rp-prose:not([data-message-id] .rp-prose)");
const writing = (page: Page) => page.locator(".stream-caret");

const endingOf = (content: string) =>
  content.trim().split(" ").slice(-3).join(" ").replaceAll("*", "");

function turnPath(url: string) {
  return new URL(url).pathname;
}

/** How many times the page has asked about the turn since this was called. */
async function countingTurnQuestions(page: Page) {
  let asks = 0;
  page.on("request", (sent) => { if (turnPath(sent.url()).endsWith("/turn")) asks += 1; });
  return () => asks;
}

/** How many times the page has started reading a turn's stream. */
function countingStreams(page: Page) {
  let streams = 0;
  page.on("request", (sent) => { if (turnPath(sent.url()).endsWith("/turn/stream")) streams += 1; });
  return () => streams;
}

/** How many times the page has asked for a turn. */
function countingPosts(page: Page) {
  let posts = 0;
  page.on("request", (sent) => { if (turnPath(sent.url()).endsWith("/api/chat")) posts += 1; });
  return () => posts;
}

/** The stream has been read again, and more words than it had are arriving. */
async function expectPickedUp(page: Page, pickedUp: Promise<unknown>) {
  await pickedUp;
  await expect(stopButton(page), "nothing to stop the reply with").toBeVisible();
  await expect(writing(page)).toBeVisible();
  await expect(writing(page)).not.toHaveText((await writing(page).textContent()) ?? "");
  await expect(stopButton(page), "nothing to stop the reply with").toBeVisible();
  await expect(page.locator("p.text-blood"), "a lost connection was reported as a failure").toHaveCount(0);
}

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
  const convo = await conversationWithReply(request, { slowly: true });
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
  await expect(writing(page)).toBeVisible();

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
  await page.evaluate(() => (window as unknown as Record<string, () => void>).__cutConnection());
  const report = page.locator("p.text-blood").first();
  await expect(report).toContainText("Evermind is not answering", { timeout: 20_000 });
  await expect(looseWords(page), "the words that had arrived vanished").not.toHaveText("");
  return { report, kept: (await looseWords(page).textContent()) ?? "" };
}

test("a reply cut off comes back by itself with the connection", async ({ page, context, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  const { report, kept } = await replyCutOff(page, context, convo.id);
  const asks = await countingTurnQuestions(page);

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

test("a reply that ended while cut off is simply there when the connection returns", async ({ page, context, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  const { report } = await replyCutOff(page, context, convo.id);
  await stopTurn(request, convo.id);

  await context.setOffline(false);
  await phoneComesBack(page);

  const reply = (await conversation(request, convo.id)).messages.at(-1);
  await expect(page.locator(`[data-message-id="${reply.id}"]`),
    "the real reply did not replace what was kept").toContainText(endingOf(reply.content));
  await expect(report, "the report stayed once the connection was back").toBeHidden();
  await expect(looseWords(page), "what was kept is still there beside the reply").toHaveCount(0);
});

for (const [name, path, sending] of [
  ["sent from this page", "api/chat", true],
  ["this page attached to", "/turn/stream", false],
] as const) {
  test(`a stream ${name} that stopped without a word is asked about when the phone comes back`, async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await connectionDiesDuring(page, path, { chunks: 3, hangs: true });
    const streams = countingStreams(page);
    if (sending) {
      await page.goto(`/#/chat/${convo.id}`);
      await page.locator("textarea").first().fill("Dors.");
      await page.locator('button[title="Send"]').click();
    } else {
      void request.post(`${API}/api/chat`, {
        data: { conversation_id: convo.id, mode: "send", content: "Dors.", message_mode: "say" },
        timeout: 120_000,
      }).catch(() => {});
      await expect.poll(() => turnRunning(request, convo.id), { timeout: 10_000 }).toBe(true);
      await page.goto(`/#/chat/${convo.id}`);
    }
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
}

test("a phone coming back does not disturb a reply that is arriving", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Vas-y.");
  await page.locator('button[title="Send"]').click();
  await expect(writing(page)).toBeVisible();

  const asks = await countingTurnQuestions(page);
  await phoneComesBack(page);
  // Two more words, which is longer than the page waits before acting on that.
  for (let word = 0; word < 2; word++) {
    await expect(writing(page)).not.toHaveText((await writing(page).textContent()) ?? "");
  }
  expect(asks(), "asked about a turn it was plainly receiving").toBe(0);

  await stopTurn(request, convo.id);
});

test("a regeneration cut off keeps the new words, not the old reply, until it comes back", async ({ page, context, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  const target = convo.messages.at(-1);
  await connectionDiesDuring(page, "api/chat");
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator(`[data-message-id="${target.id}"]`)).toBeVisible();
  await page.locator('button[title="Regenerate"]').first().click({ force: true });
  await expect(writing(page)).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => (window as unknown as Record<string, () => void>).__cutConnection());
  await expect(page.locator("p.text-blood").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-message-id="${target.id}"]`),
    "the reply being replaced came back above its replacement").toBeHidden();
  await stopTurn(request, convo.id);

  await context.setOffline(false);
  await phoneComesBack(page);
  await expect(page.locator(`[data-message-id="${target.id}"]`)).toBeVisible();
  const after = (await conversation(request, convo.id)).messages;
  expect(after.length, "a reply was added instead of replaced").toBe(convo.messages.length);
  expect(after.at(-1).variants.length).toBe(2);
});

/** Every stream of a turn, sent or followed, ends cleanly after `chunks` chunks, for
 *  the first `times` of them, which `window.__closesLeft` can change meanwhile. */
async function streamsKeepClosing(page: Page, times: number, chunks = 3) {
  await page.addInitScript(({ times, chunks }) => {
    const realFetch = window.fetch;
    const page_ = window as unknown as { __closesLeft: number };
    page_.__closesLeft = times;
    window.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      const url = String(input);
      const stream = url.endsWith("api/chat") || url.endsWith("/turn/stream");
      if (!stream || page_.__closesLeft <= 0 || !response.body) return response;
      page_.__closesLeft -= 1;
      const reader = response.body.getReader();
      let passed = 0;
      const body = new ReadableStream({
        async pull(controller) {
          if (passed++ >= chunks) {
            await reader.cancel();
            controller.close();
            return;
          }
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };
  }, { times, chunks });
}

test("a stream that keeps closing does not leave part of a reply on screen", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await streamsKeepClosing(page, 2);
  const streams = countingStreams(page);
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Coupe.");
  await page.locator('button[title="Send"]').click();

  await expect.poll(streams, { timeout: 20_000, message: "not read again" }).toBe(2);
  await expect(stopButton(page), "nothing to stop the reply with").toBeVisible();
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
  const reply = (await conversation(request, convo.id)).messages.at(-1);
  await expect(page.locator(`[data-message-id="${reply.id}"]`),
    "the reply stayed as far as it had got").toContainText(endingOf(reply.content));
  await expect(page.locator("p.text-blood")).toHaveCount(0);
});

test("a stream that closes again and again with no new word gives up, and says so", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await streamsKeepClosing(page, 1_000, 1);
  const streams = countingStreams(page);
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Coupe.");
  await page.locator('button[title="Send"]').click();

  const report = page.locator("p.text-blood").first();
  await expect(report, "still trying, or silent").toContainText("Evermind is not answering", { timeout: 20_000 });
  await expect(stopButton(page)).toBeHidden();
  expect(streams(), "no limit on reading it again").toBeLessThan(20);

  // Whatever was closing them lets go, and the phone coming back finds the reply.
  await page.evaluate(() => { (window as unknown as { __closesLeft: number }).__closesLeft = 0; });
  await phoneComesBack(page);
  await expect(report, "the report stayed once it worked").toBeHidden();
  await stopTurn(request, convo.id);
  await expect(stopButton(page)).toBeHidden();
});

const retryButton = (page: Page) => page.getByRole("button", { name: "Retry" });

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

test("it is reported long after, when the server has forgotten the turn", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { failing: true });
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "Personne.", message_mode: "say" },
    timeout: 60_000,
  });
  await page.route("**/turn", (route) => route.fulfill({
    json: { running: false, mode: null, ended_recently: false },
  }));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("p.text-blood").first()).toContainText("The reply did not arrive");
});

test("no alarm if the state of the turn cannot be read", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { failing: true });
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "Personne.", message_mode: "say" },
    timeout: 60_000,
  });
  const asked = page.waitForRequest("**/turn");
  await page.route("**/turn", (route) => route.abort("failed"));
  await page.goto(`/#/chat/${convo.id}`);
  await asked;
  await page.waitForLoadState("networkidle");
  await expect(page.locator("textarea").first()).toBeVisible();
  await expect(page.locator("p.text-blood")).toHaveCount(0);
});

/** Opens a conversation and checks, once the page has read everything, that it has
 *  nothing to report. */
async function expectNoAlarm(page: Page, convoId: string, because: string) {
  // Reloaded, because going to the address a page is already at opens nothing.
  await page.goto(`/#/chat/${convoId}`);
  await page.reload();
  await expect(page.locator("textarea").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("p.text-blood"), `a false alarm: ${because}`).toHaveCount(0);
  await expect(retryButton(page)).toHaveCount(0);
}

test("a new conversation raises no alarm", async ({ page, request }) => {
  const greeted = await makeConversation(request);
  await expectNoAlarm(page, greeted.id, "nothing has been said yet");
  const silent = await makeConversation(request, { greeting: "" });
  expect(silent.messages ?? [], "this one was meant to have no greeting").toHaveLength(0);
  await expectNoAlarm(page, silent.id, "nothing has been said yet, and no greeting either");
});

test("a reply stopped before any word raises no alarm", async ({ page, request }) => {
  // The model takes a couple of seconds to refuse, which is the time to stop it in.
  const convo = await conversationWithReply(request, { failing: true });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Non, rien.");
  await page.locator('button[title="Send"]').click();
  await stopButton(page).click();
  await expect(stopButton(page)).toBeHidden();
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 15_000 }).toBe(false);
  await expect(page.getByText("Non, rien."), "what was said is still there").toBeVisible();

  const last = (await conversation(request, convo.id)).messages.at(-1);
  expect(last.role, "a word arrived before it was stopped").toBe("user");
  await expectNoAlarm(page, convo.id, "the person stopped it themselves");
});

test("a conversation that ends on a message for other reasons raises no alarm", async ({ page, request }) => {
  // The reply was deleted: it was there, and now it is not on purpose.
  const convo = await conversationWithReply(request);
  const reply = convo.messages.at(-1);
  await request.delete(`${API}/api/messages/${reply.id}?following=true`);
  expect((await conversation(request, convo.id)).messages.at(-1).role).toBe("user");
  await expectNoAlarm(page, convo.id, "the reply was deleted");

  // A branch, cut at a message of the person's.
  const asked = (await conversation(request, convo.id)).messages.at(-1);
  const branch = await (await request.post(`${API}/api/messages/${asked.id}/branch`)).json();
  expect(branch.messages.at(-1).role).toBe("user");
  await expectNoAlarm(page, branch.id, "the story was branched here");
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

test("retrying shows a reply that has landed, without asking for another", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await connectionDiesDuring(page, "api/chat", { chunks: 3, staysDead: true });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Coupe.");
  await page.locator('button[title="Send"]').click();
  await expect(retryButton(page)).toBeVisible({ timeout: 20_000 });
  await stopTurn(request, convo.id);

  await page.evaluate(() => (window as unknown as Record<string, () => void>).__connectionBack());
  const posts = countingPosts(page);
  await retryButton(page).click();

  const reply = (await conversation(request, convo.id)).messages.at(-1);
  await expect(page.locator(`[data-message-id="${reply.id}"]`)).toContainText(endingOf(reply.content));
  await expect(retryButton(page), "the report stayed").toBeHidden();
  expect(posts(), "asked for another reply when there was one to show").toBe(0);
  expect((await conversation(request, convo.id)).messages.at(-1).variants.length, "a new variant for nothing").toBe(1);
});

test("retrying asks for a reply when the server has none to show", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { failing: true });
  await connectionDiesDuring(page, "api/chat", { chunks: 1, staysDead: true });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Sans reponse.");
  await page.locator('button[title="Send"]').click();
  await expect(retryButton(page)).toBeVisible({ timeout: 20_000 });

  // The turn fails while nobody is reading it, and is forgotten long before anyone
  // looks: nothing left to hand over, and a message with no reply under it.
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 20_000 }).toBe(false);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });
  await page.route("**/turn", (route) => route.fulfill({
    json: { running: false, mode: null, ended_recently: false },
  }));

  // Coming back finds that out by itself, and says so in other words than before:
  // Evermind is answering, it is the reply that is missing.
  await page.evaluate(() => (window as unknown as Record<string, () => void>).__connectionBack());
  await phoneComesBack(page);
  await expect(page.locator("p.text-blood").first()).toContainText("The reply did not arrive");

  await retryButton(page).click();

  const expected = convo.messages.length + 2;
  await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
    { timeout: 30_000, message: "no reply was asked for" }).toBe(expected);
  await expect(page.locator("[data-message-id]")).toHaveCount(expected, { timeout: 30_000 });
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

test("a page attached mid-turn reports the model failing, as the sending page does", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { failing: true });
  const failing = request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "Echoue.", message_mode: "say" },
    timeout: 60_000,
  });
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 10_000 }).toBe(true);

  await page.goto(`/#/chat/${convo.id}`);
  await expect(stopButton(page), "the page did not attach before the turn failed").toBeVisible();
  await failing;
  await expect(page.locator("p.text-blood").first(), "the failure went unreported").toContainText("500");
  await expect(stopButton(page)).toBeHidden();
});

test("a page attached mid-turn says so when the model did not answer", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const off = await (await request.post(`${API}/api/connections`, {
    data: {
      name: "off", provider: "openai-compatible",
      base_url: "http://127.0.0.1:5999/v1", api_key: "x", model: "absent",
    },
  })).json();
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { connection_id: off.id } });
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "Personne ?", message_mode: "say" },
    timeout: 60_000,
  });
  // A closed port fails at once, so the page is told the turn is running, as it
  // would be had it asked a moment sooner. What it then reads is the real ending.
  await page.route("**/turn", (route) => route.fulfill({
    json: { running: true, mode: "send", ended_recently: false },
  }));
  await page.goto(`/#/chat/${convo.id}`);

  await expect(page.getByText(/no answer from the model/i), "the silence went unreported").toBeVisible();
  await expect(page.locator("p.text-blood"), "a server that is merely off was reported as a fault").toHaveCount(0);
});
