import { expect, test, type Page } from "@playwright/test";
import { API } from "../playwright.config";
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

/**
 * What a phone going to sleep does to a reply being read: the request rejects part
 * way through the answer, and the server, whose turn it is, carries on. Routing
 * cannot produce that (fulfilling a route always ends the body cleanly, and
 * offline mode leaves an established connection alone), so it is `fetch` in the
 * page that is replaced. Once, on the first request to `path`, after three chunks
 * of the answer. With `staysDead`, nothing gets through after that.
 */
async function connectionDiesDuring(page: Page, path: string, { staysDead = false } = {}) {
  await page.addInitScript(({ path, staysDead }) => {
    const realFetch = window.fetch;
    let cut = false;
    let dead = false;
    window.fetch = async (input, init) => {
      if (dead) throw new TypeError("Failed to fetch");
      const response = await realFetch(input, init);
      if (cut || !String(input).endsWith(path) || !response.body) return response;
      cut = true;
      const reader = response.body.getReader();
      let passed = 0;
      const body = new ReadableStream({
        async pull(controller) {
          if (passed++ >= 3) {
            dead = staysDead;
            await reader.cancel();
            controller.error(new TypeError("network error"));
            return;
          }
          const { value, done } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };
  }, { path, staysDead });
}

const stopButton = (page: Page) => page.locator('button[title="Stop generation"]');
const writing = (page: Page) => page.locator(".stream-caret");

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
  await connectionDiesDuring(page, "api/chat");
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

test("a reply that landed while the connection was down is on screen when it returns", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await connectionDiesDuring(page, "api/chat");
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
  await connectionDiesDuring(page, "api/chat");
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

  await connectionDiesDuring(page, "/turn/stream");
  const streams: string[] = [];
  page.on("request", (sent) => { if (sent.url().endsWith("/turn/stream")) streams.push(sent.url()); });
  await page.goto(`/#/chat/${convo.id}`);
  await expect.poll(() => streams.length, { timeout: 15_000 }).toBe(2);
  await expectPickedUp(page, Promise.resolve());

  await stopTurn(request, convo.id);
});

test("a connection that stays dead is reported rather than left silent", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await connectionDiesDuring(page, "api/chat", { staysDead: true });
  await page.goto(`/#/chat/${convo.id}`);

  await page.locator("textarea").first().fill("Personne.");
  await page.locator('button[title="Send"]').click();

  const report = page.locator("p.text-blood").first();
  await expect(report, "the connection died and nothing said so").toBeVisible({ timeout: 20_000 });
  await expect(report).toContainText("Evermind is not answering");
  await expect(stopButton(page), "still claiming to be receiving a reply").toBeHidden();

  // The server never heard any of this, and is still writing.
  await stopTurn(request, convo.id);
});
