import { expect, test, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import {
  connectionBack, connectionDiesDuring, countingPosts, countingStreams, countingTurnQuestions, endingOf,
  expectPickedUp, goWithinThePage, looseWords, phoneComesBack, report, retryButton, stopButton,
  writing,
} from "./connection";
import { conversation, conversationWithReply, stopTurn, turnRunning } from "./fixtures";

/**
 * What happens when two things meant for the same turn, or for two turns, arrive in
 * the wrong order. Each of these was found by making it happen.
 */
test.setTimeout(120_000);

const send = async (page: Page, text: string) => {
  await page.locator("textarea").first().fill(text);
  await page.locator('button[title="Send"]').click();
};

/** Another device, asking for a turn. Not awaited: it runs while the test goes on. */
function elsewhere(request: Parameters<typeof turnRunning>[0], id: string, data: Record<string, unknown>) {
  return request.post(`${API}/api/chat`, {
    data: { conversation_id: id, message_mode: "say", ...data }, timeout: 120_000,
  }).catch(() => {});
}

const sayMode = (page: Page) => page.locator('button[title^="Say / action"]');
const narrationMode = (page: Page) => page.locator('button[title^="Narration"]');
const narrating = (page: Page) => sayMode(page).click();

/** Whatever the page was going to do about what it has just been told, it has done:
 *  it has had a round trip to do it in, and has drawn the result. */
const settled = (page: Page) => page.evaluate(async () => {
  await fetch("api/health");
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});

test.describe("Stop", () => {
  test("stopping while the server is being asked about the turn stays stopped", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true, quiet: true });
    await connectionDiesDuring(page, "api/chat", { chunks: 1, hangs: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Dors.");
    await expect(stopButton(page)).toBeVisible();

    // The answer is the server's from before the stop, and arrives after it.
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let answered = () => {};
    const answer = new Promise<void>((resolve) => { answered = resolve; });
    await page.route("**/turn", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      answered();
      await released;
      await route.fulfill({ response });
    });
    let asked = false;
    void answer.then(() => { asked = true; });
    await expect.poll(async () => {
      await phoneComesBack(page);
      return asked;
    }, { timeout: 15_000 }).toBe(true);

    await stopButton(page).click();
    await expect(stopButton(page)).toBeHidden();
    const streams = countingStreams(page);
    const delivered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/turn"));
    release();
    await delivered;
    await settled(page);
    expect(streams(), "read the turn again after Stop").toBe(0);
    await expect(stopButton(page), "the stop button came back after Stop").toBeHidden();
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 10_000 }).toBe(false);
  });

  test("a regeneration stopped during that does not report a reply that went missing", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { quiet: true });
    await connectionDiesDuring(page, "api/chat", { chunks: 1 });
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let questions = 0;
    await page.route("**/turn", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      questions += 1;
      if (questions > 1) await released;
      await route.continue();
    });
    await page.goto(`/#/chat/${convo.id}`);
    await expect(page.locator("textarea").first()).toBeVisible();
    await page.waitForLoadState("networkidle");

    await page.locator('button[title="Regenerate"]').first().click({ force: true });
    await expect.poll(() => questions, { timeout: 15_000 }).toBeGreaterThan(1);
    await stopButton(page).click();
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 20_000 }).toBe(false);

    release();
    await expect(stopButton(page)).toBeHidden();
    await page.waitForLoadState("networkidle");
    await expect(report(page), "a false alarm after a stop").toHaveCount(0);
  });

  test("stopping a turn that has just ended, as it is being handed over, stops", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await connectionDiesDuring(page, "api/chat", { chunks: 3 });
    // The ending of the turn is on its way when the person stops it.
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let asked = () => {};
    const askedForIt = new Promise<void>((resolve) => { asked = resolve; });
    await page.route("**/turn/stream", async (route) => {
      asked();
      await released;
      await route.continue();
    });
    await page.route("**/turn", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
      await route.continue();
    });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Coupe.");
    await expect(writing(page)).toBeVisible();
    await request.delete(`${API}/api/conversations/${convo.id}/turn`);

    await askedForIt;
    await stopButton(page).click();
    release();
    await expect(stopButton(page), "a stop button that does nothing").toBeHidden();
    await page.waitForLoadState("networkidle");
    await expect(report(page), "a false alarm after a stop").toHaveCount(0);
  });

  test("a stop that could not be said is said again when the connection returns", async ({ page, context, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Vas-y.");
    await expect(writing(page)).toBeVisible();

    await context.setOffline(true);
    await stopButton(page).click();
    await expect(report(page).first(), "the stop failed and nothing said so")
      .toContainText("Evermind is not answering");
    expect(await turnRunning(request, convo.id), "the server was told after all").toBe(true);

    await context.setOffline(false);
    await phoneComesBack(page);
    await expect.poll(() => turnRunning(request, convo.id), {
      timeout: 10_000, message: "the stop was not said again",
    }).toBe(false);
    await expect(report(page), "the report stayed once it worked").toHaveCount(0);
  });

  test("stopping keeps every word that had arrived", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Vas-y.");
    await expect.poll(async () => ((await writing(page).textContent()) ?? "").length,
      { timeout: 15_000 }).toBeGreaterThan(15);

    const seen = ((await writing(page).textContent()) ?? "").replaceAll("*", "").trim();
    await stopButton(page).click();
    await expect(stopButton(page)).toBeHidden();
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 10_000 }).toBe(false);

    const reply = (await conversation(request, convo.id)).messages.at(-1);
    expect(reply.content.replaceAll("*", ""), "what was on screen is gone").toContain(seen);
    await expect(page.locator(`[data-message-id="${reply.id}"]`)).toBeVisible();
  });

  /** A reply being written, with words on the screen that the conversation does not
   *  have yet, and the stop held back so that what the page reads as it stops is from
   *  before the server has heard. Says what the words are. */
  async function wordsAheadOfTheConversation(page: Page, request: Parameters<typeof turnRunning>[0], id: string) {
    await page.route("**/turn", async (route) => {
      if (route.request().method() === "DELETE") await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.goto(`/#/chat/${id}`);
    await send(page, "Vas-y.");
    let seen = "";
    await expect.poll(async () => {
      seen = ((await writing(page).textContent()) ?? "").replaceAll("*", "").trim();
      const kept = (await conversation(request, id)).messages.at(-1);
      return seen.length > 15 && !kept.content.replaceAll("*", "").includes(seen);
    }, { timeout: 30_000, intervals: [100] }).toBe(true);
    return seen;
  }

  test("stopping keeps them on the screen too", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    const seen = await wordsAheadOfTheConversation(page, request, convo.id);
    await stopButton(page).click();
    await expect(stopButton(page)).toBeHidden();

    await expect.poll(() => turnRunning(request, convo.id), { timeout: 10_000 }).toBe(false);
    const reply = (await conversation(request, convo.id)).messages.at(-1);
    await expect(page.locator(`[data-message-id="${reply.id}"]`), "gone from the screen").toContainText(seen);
  });

  test("a read from before the stop, answered last, does not take them away", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    const seen = await wordsAheadOfTheConversation(page, request, convo.id);

    // The second read after the stop is sent before the server has heard, and is held
    // until after the read that is sent once it has.
    let reads = 0;
    let delivered = () => {};
    const late = new Promise<void>((resolve) => { delivered = resolve; });
    await page.route(`**/api/conversations/${convo.id}`, async (route) => {
      if (++reads !== 2) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.fulfill({ response });
      delivered();
    });
    await stopButton(page).click();
    await late;
    await settled(page);

    expect(reads, "this was meant to catch one read answering after another").toBeGreaterThan(2);
    const reply = (await conversation(request, convo.id)).messages.at(-1);
    await expect(page.locator(`[data-message-id="${reply.id}"]`), "gone from the screen").toContainText(seen);
  });

  test("retrying after a stop that could not be said says it, and asks for nothing", async ({ page, context, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Vas-y.");
    await expect(writing(page)).toBeVisible();

    await context.setOffline(true);
    await stopButton(page).click();
    await expect(report(page).first()).toContainText("Evermind is not answering");
    await context.setOffline(false);

    const posts = countingPosts(page);
    await retryButton(page).click();
    await expect.poll(() => turnRunning(request, convo.id), {
      timeout: 10_000, message: "the stop was not said again",
    }).toBe(false);
    await expect(report(page), "the report stayed once it worked").toHaveCount(0);
    expect(posts(), "retrying a stop asked for another reply").toBe(0);
    expect((await conversation(request, convo.id)).messages.at(-1).variants.length).toBe(1);
  });

  test("stopping and sending straight away sends", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { quiet: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Premier.");
    await expect(stopButton(page)).toBeVisible();
    await stopButton(page).click();
    await expect(stopButton(page)).toBeHidden();
    await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });

    await send(page, "Second.");
    const words = async () => (await conversation(request, convo.id)).messages
      .map((m: { content: string }) => m.content);
    await expect.poll(words, { timeout: 15_000, message: "the message vanished" }).toContain("Second.");
    await expect(page.getByText("Second.")).toHaveCount(1);
    await expect(report(page)).toHaveCount(0);
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
  });
});

test.describe("sending while a reply is being written", () => {
  const notice = (page: Page) => report(page).filter({ hasText: "already being written" });

  test("the message stays in the box and the page joins the reply", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await page.goto(`/#/chat/${convo.id}`);
    await expect(page.locator("textarea").first()).toBeVisible();
    void elsewhere(request, convo.id, { mode: "send", content: "Depuis ailleurs." });
    await expect.poll(() => turnRunning(request, convo.id)).toBe(true);

    await send(page, "Et ceci ?");
    await expect(stopButton(page), "did not join the reply").toBeVisible();
    await expect(notice(page), "nothing said why it was not sent").toBeVisible();
    await expect(page.locator("textarea").first(), "the message was lost").toHaveValue("Et ceci ?");
    await expect(page.locator("[data-message-id]").filter({ hasText: "Et ceci ?" }),
      "drawn as though it was sent").toHaveCount(0);
    await expect(page.getByText("Depuis ailleurs.")).toBeVisible();

    await stopTurn(request, convo.id);
    await expect(notice(page), "still saying so after it ended").toHaveCount(0);
    await expect(page.locator("textarea").first()).toHaveValue("Et ceci ?");
  });

  test("the same from a reply cut off, which is asked about first", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await connectionDiesDuring(page, "api/chat", { chunks: 3, staysDead: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Coupe.");
    await expect(report(page).first()).toBeVisible({ timeout: 20_000 });
    await connectionBack(page);

    const posts = countingStreams(page);
    await send(page, "Et ceci ?");
    await expect(stopButton(page), "did not join the reply").toBeVisible();
    await expect(page.locator("textarea").first(), "the message was lost").toHaveValue("Et ceci ?");
    await expect(notice(page)).toBeVisible();
    expect(posts(), "joined it without reading it").toBeGreaterThan(0);

    // It ends, and now it goes.
    await stopTurn(request, convo.id);
    await expect(stopButton(page)).toBeHidden();
    await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });
    await page.locator('button[title="Send"]').click();
    const words = async () => (await conversation(request, convo.id)).messages
      .map((m: { content: string }) => m.content);
    await expect.poll(words, { timeout: 15_000 }).toContain("Et ceci ?");
    await expect(page.locator("textarea").first()).toHaveValue("");
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
  });

  test("a message sent from a reply cut off, with nothing to be reached, stays in the box", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await connectionDiesDuring(page, "api/chat", { chunks: 3, staysDead: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Coupe.");
    await expect(report(page).first()).toBeVisible({ timeout: 20_000 });

    const words = await looseWords(page).textContent();
    await send(page, "Et ceci ?");
    await expect(page.locator("textarea").first(), "the message was lost").toHaveValue("Et ceci ?");
    await expect(looseWords(page), "what had arrived went with it").toHaveText(words ?? "");
    await expect(report(page).first()).toContainText("Evermind is not answering");
    await stopTurn(request, convo.id);
  });

  /** Refused, once `release` is called. Another device's reply is being written. */
  async function refusalOnItsWay(
    page: Page, request: Parameters<typeof turnRunning>[0], id: string, beforeSending = async () => {},
  ) {
    await page.goto(`/#/chat/${id}`);
    await expect(page.locator("textarea").first()).toBeVisible();
    void elsewhere(request, id, { mode: "send", content: "Depuis ailleurs." });
    await expect.poll(() => turnRunning(request, id)).toBe(true);

    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/chat", async (route) => {
      await released;
      await route.continue();
    });
    const refused = page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.status() === 409);
    await beforeSending();
    await send(page, "Et ceci ?");
    await expect(page.locator("textarea").first()).toHaveValue("");
    return async () => {
      release();
      await refused;
      await settled(page);
    };
  }

  test("a message refused after the page was left is there on coming back", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    const refusal = await refusalOnItsWay(page, request, convo.id);
    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await refusal();

    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(page.locator("textarea").first(), "the message was lost").toHaveValue("Et ceci ?");
    await stopTurn(request, convo.id);
  });

  test("the same if the person is back before the refusal arrives", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    const refusal = await refusalOnItsWay(page, request, convo.id);
    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(page.locator("textarea").first()).toHaveValue("");
    await refusal();

    await expect(page.locator("textarea").first(), "the message was lost").toHaveValue("Et ceci ?");
    await stopTurn(request, convo.id);
  });

  test("a narration refused after the page was left comes back as a narration", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    const refusal = await refusalOnItsWay(page, request, convo.id, () => narrating(page));
    await expect(sayMode(page), "the box went back to speaking").toBeVisible();
    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await refusal();

    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(page.locator("textarea").first()).toHaveValue("Et ceci ?");
    await expect(narrationMode(page), "it came back as something else").toBeVisible();
    await stopTurn(request, convo.id);
  });

  test("a message refused after the page was left survives another tab typing", async ({ page, context, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    const refusal = await refusalOnItsWay(page, request, convo.id);
    const other = await context.newPage();
    await other.goto(`/#/chat/${convo.id}`);
    await expect(other.locator("textarea").first()).toBeVisible();
    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await refusal();

    await other.locator("textarea").first().fill("Depuis l'autre onglet.");
    await expect.poll(() => other.evaluate((id) => localStorage.getItem(`evermind:draft:${id}`), convo.id))
      .toBe("Depuis l'autre onglet.");
    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(page.locator("textarea").first(), "the message was lost")
      .toHaveValue("Et ceci ?\nDepuis l'autre onglet.");
    await stopTurn(request, convo.id);
  });

  test("what was typed while waiting for the refusal is kept as well", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    const refusal = await refusalOnItsWay(page, request, convo.id);
    await page.locator("textarea").first().fill("Et puis ceci.");
    await refusal();

    await expect(page.locator("textarea").first()).toHaveValue("Et ceci ?\nEt puis ceci.");
    await stopTurn(request, convo.id);
  });

  test("joining another device's regeneration hides the reply it replaces", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    const target = convo.messages.at(-1);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(page.locator(`[data-message-id="${target.id}"]`)).toBeVisible();
    void elsewhere(request, convo.id, { mode: "regenerate" });
    await expect.poll(() => turnRunning(request, convo.id)).toBe(true);

    await send(page, "Et ceci ?");
    await expect(writing(page)).toBeVisible();
    await expect(page.locator(`[data-message-id="${target.id}"]`),
      "on screen under its own replacement").toBeHidden();
    await stopTurn(request, convo.id);
  });
});

test.describe("two conversations", () => {
  test("each keeps its own words", async ({ page, request }) => {
    const a = await conversationWithReply(request, { slowly: true, says: "alpha" });
    const b = await conversationWithReply(request, { slowly: true, says: "bravo" });
    await page.goto(`/#/chat/${a.id}`);
    await send(page, "Dans A.");
    await expect(writing(page)).toContainText("alpha");

    await goWithinThePage(page, `/chat/${b.id}`);
    await expect(page.locator(`[data-message-id="${b.messages.at(-1).id}"]`)).toBeVisible();
    await send(page, "Dans B.");
    await expect(writing(page)).toContainText("bravo one two");
    await expect(writing(page), "the words of A appeared in B").not.toContainText("alpha");
    expect((await writing(page).textContent())?.match(/bravo/g)?.length, "every word twice").toBe(1);

    // And A is still its own when it is come back to.
    await goWithinThePage(page, `/chat/${a.id}`);
    await expect(writing(page)).toContainText("alpha");
    await expect(writing(page)).not.toContainText("bravo");
    await stopTurn(request, a.id);
    await stopTurn(request, b.id);
  });

  test("a connection lost in one does not take the page showing the other", async ({ page, request }) => {
    const a = await conversationWithReply(request, { slowly: true, says: "alpha" });
    const b = await conversationWithReply(request, { slowly: true, says: "bravo" });
    await connectionDiesDuring(page, "api/chat", { chunks: 6 });
    const streams = countingStreams(page);
    await page.goto(`/#/chat/${a.id}`);
    await send(page, "Dans A.");
    await expect(writing(page)).toBeVisible();

    await goWithinThePage(page, `/chat/${b.id}`);
    await expect(page.locator(`[data-message-id="${b.messages.at(-1).id}"]`)).toBeVisible();
    await send(page, "Dans B.");
    await expect(stopButton(page)).toBeVisible();

    // A's connection goes by itself, a few words in, and is picked up from there.
    await expect.poll(streams, { timeout: 20_000, message: "A's stream was never cut" }).toBeGreaterThan(0);
    await expect(stopButton(page), "B is being written and the page cannot stop it").toBeVisible();
    await expect(writing(page)).toContainText("bravo");
    await expect(writing(page)).not.toContainText("alpha");
    await stopTurn(request, a.id);
    await stopTurn(request, b.id);
  });
});

test.describe("leaving and coming back", () => {
  test("a model failing after coming back is reported on the page being looked at", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { failing: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Echoue.");
    await expect(stopButton(page)).toBeVisible();
    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(stopButton(page)).toBeVisible();

    await expect.poll(() => turnRunning(request, convo.id), { timeout: 15_000 }).toBe(false);
    await expect(report(page).first(), "the failure went unreported").toContainText("500");
    await expect(stopButton(page)).toBeHidden();
  });

  test("a model failing while away is reported on coming back", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { failing: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Echoue.");
    await expect(stopButton(page)).toBeVisible();
    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 15_000 }).toBe(false);

    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(report(page).first(), "the reason was lost").toContainText("500");
  });

  test("a reader that went quiet while away is noticed on coming back", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await connectionDiesDuring(page, "api/chat", { chunks: 3, hangs: true });
    const streams = countingStreams(page);
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Dors.");
    await expect(writing(page)).toBeVisible();

    // Coming back is all that can notice, once no word has arrived for a while.
    await expect.poll(async () => {
      await goWithinThePage(page, "/chat");
      await expect(page.locator("textarea")).toHaveCount(0);
      await goWithinThePage(page, `/chat/${convo.id}`);
      await expect(page.locator("textarea").first()).toBeVisible();
      await settled(page);
      return streams();
    }, { timeout: 30_000, message: "a stream that had stopped was not asked about" }).toBeGreaterThan(0);
    await expectPickedUp(page, Promise.resolve());
    await stopTurn(request, convo.id);
  });

  test("a reply ending while the page come back to has its first read is shown whole", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Ecris.");
    await expect(writing(page)).toBeVisible();
    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect.poll(async () =>
      (await conversation(request, convo.id)).messages.at(-1).meta.streaming === true).toBe(true);

    // Read mid-reply, and handed over once it has ended.
    let held = false;
    await page.route(`**/api/conversations/${convo.id}`, async (route) => {
      if (held || route.request().method() !== "GET") return route.continue();
      held = true;
      const response = await route.fetch();
      await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
      await route.fulfill({ response });
    });
    await goWithinThePage(page, `/chat/${convo.id}`);

    await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
    const reply = (await conversation(request, convo.id)).messages.at(-1);
    await expect(page.locator(`[data-message-id="${reply.id}"]`),
      "truncated, with nothing to replace it").toContainText(endingOf(reply.content));
    await expect(stopButton(page)).toBeHidden();
  });
});

test.describe("where a reply is reported missing", () => {
  test("not on a branch cut at a message left unanswered", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { failing: true });
    await request.post(`${API}/api/chat`, {
      data: { conversation_id: convo.id, mode: "send", content: "Personne.", message_mode: "say" },
      timeout: 60_000,
    });
    const asked = (await conversation(request, convo.id)).messages.at(-1);
    expect(asked.meta.unanswered).toBe(true);
    const branch = await (await request.post(`${API}/api/messages/${asked.id}/branch`)).json();

    await page.goto(`/#/chat/${branch.id}`);
    await expect(page.locator("textarea").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(report(page), "a false alarm on a branch").toHaveCount(0);
  });

  test("not on a branch cut at the message being answered", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    void elsewhere(request, convo.id, { mode: "send", content: "Ecris." });
    const content = async () => (await conversation(request, convo.id)).messages
      .find((m: { content: string }) => m.content === "Ecris.");
    await expect.poll(async () => (await content()) !== undefined).toBe(true);
    const asked = await content();
    const branch = await (await request.post(`${API}/api/messages/${asked.id}/branch`)).json();
    await stopTurn(request, convo.id);

    await page.goto(`/#/chat/${branch.id}`);
    await expect(page.locator("textarea").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(report(page), "a false alarm on a branch").toHaveCount(0);
  });

  test("not when another device has just started on it", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true, quiet: true });
    // The page's question about the turn is answered first, with nothing running.
    // Only then does the other device send, and only then does the page get its read.
    const stateAnswered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/turn"));
    let first = true;
    await page.route(`**/api/conversations/${convo.id}`, async (route) => {
      if (!first || route.request().method() !== "GET") return route.continue();
      first = false;
      await stateAnswered;
      void elsewhere(request, convo.id, { mode: "send", content: "Autre appareil." });
      await expect.poll(async () => (await conversation(request, convo.id)).messages
        .some((m: { content: string }) => m.content === "Autre appareil.")).toBe(true);
      await route.continue();
    });
    await page.goto(`/#/chat/${convo.id}`);

    await expect(stopButton(page), "did not notice the reply being written").toBeVisible();
    await expect(report(page), "a false alarm: the reply is being written").toHaveCount(0);
    await stopTurn(request, convo.id);
  });

  test("not on a message a failed turn had nothing to do with", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await request.delete(`${API}/api/messages/${convo.messages.at(-1).id}?following=true`);
    // Refused, there being no reply to continue.
    await request.post(`${API}/api/chat`, {
      data: { conversation_id: convo.id, mode: "continue" }, timeout: 30_000,
    });
    await page.goto(`/#/chat/${convo.id}`);
    await expect(page.locator("textarea").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(report(page), "a false alarm: the reply was deleted").toHaveCount(0);
  });

  test("no more once the message it was about is deleted", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { failing: true });
    await request.post(`${API}/api/chat`, {
      data: { conversation_id: convo.id, mode: "send", content: "Personne.", message_mode: "say" },
      timeout: 60_000,
    });
    const asked = (await conversation(request, convo.id)).messages.at(-1);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(report(page).first()).toContainText("did not arrive");

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator(`[data-message-id="${asked.id}"] button[title="Delete from here"]`).click({ force: true });
    await expect(page.locator(`[data-message-id="${asked.id}"]`)).toHaveCount(0);
    await expect(report(page), "still reporting a message that was deleted").toHaveCount(0);
  });
});

test("deleting a message while its reply is being written does not break the page", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/#/chat/${convo.id}`);
  await send(page, "Efface-moi.");
  await expect(writing(page)).toBeVisible();
  const mine = (await conversation(request, convo.id)).messages
    .find((m: { content: string }) => m.content === "Efface-moi.");

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(`[data-message-id="${mine.id}"] button[title="Delete from here"]`).click({ force: true });
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
  await expect(stopButton(page)).toBeHidden();
  await page.waitForLoadState("networkidle");

  await expect(page.locator("textarea").first(), "the page went down with it").toBeVisible();
  expect(errors).toEqual([]);
  await expect(report(page), "something was reported for what was asked for").toHaveCount(0);
  const contents = (await conversation(request, convo.id)).messages.map((m: { content: string }) => m.content);
  expect(contents, "the message came back").not.toContain("Efface-moi.");
  expect(contents.length, "its reply was kept").toBe(convo.messages.length);
});

test.describe("what is asked of a connection that does not answer", () => {
  test("a check that cannot read the conversation does not leave the page stuck", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await connectionDiesDuring(page, "api/chat", { chunks: 3 });
    // The answer about the turn waits until the turn has ended. By then the
    // conversation cannot be read.
    await page.route("**/turn", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
      await route.continue();
    });
    await page.goto(`/#/chat/${convo.id}`);
    await expect(page.locator("textarea").first()).toBeVisible();
    await page.route(`**/api/conversations/${convo.id}`, (route) =>
      (route.request().method() === "GET" ? route.abort("failed") : route.continue()));
    await send(page, "Coupe.");
    await expect(stopButton(page)).toBeVisible();
    await expect(writing(page)).toBeVisible();
    await stopTurn(request, convo.id);

    await expect(stopButton(page), "a stop button that does nothing").toBeHidden({ timeout: 10_000 });
    await expect(report(page).first()).toContainText("Evermind is not answering");
  });

  test("the ending of a turn that never comes does not stop anything else being asked", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await connectionDiesDuring(page, "api/chat", { chunks: 3 });
    // The turn is over by the time the page is told, and reading it then hangs.
    let hang = true;
    await page.route("**/turn/stream", async (route) => {
      if (!hang) await route.continue();
    });
    await page.route("**/turn", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
      await route.continue();
    });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Coupe.");

    await expect(report(page).first(), "still waiting").toContainText("Evermind is not answering", { timeout: 25_000 });
    await expect(stopButton(page), "a stop button with nothing behind it").toBeHidden();

    hang = false;
    await phoneComesBack(page);
    await expect(report(page), "the report stayed once it worked").toHaveCount(0);
    const reply = (await conversation(request, convo.id)).messages.at(-1);
    await expect(page.locator(`[data-message-id="${reply.id}"]`)).toContainText(endingOf(reply.content));
  });

  test("a question that hangs does not stop the next one being asked", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await connectionDiesDuring(page, "api/chat", { chunks: 3, staysDead: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Coupe.");
    await expect(report(page).first()).toBeVisible({ timeout: 20_000 });
    await connectionBack(page);

    // Never answered, as on a socket that has died without saying so.
    let hang = true;
    await page.route("**/turn", async (route) => {
      if (route.request().method() !== "GET" || !hang) return route.continue();
    });
    const asks = countingTurnQuestions(page);
    await phoneComesBack(page);
    await expect.poll(asks).toBe(1);
    hang = false;

    const pickedUp = page.waitForRequest("**/turn/stream", { timeout: 30_000 });
    await expect.poll(async () => {
      await phoneComesBack(page);
      return asks();
    }, { timeout: 20_000, message: "nothing can ask again while one question hangs" }).toBeGreaterThan(1);
    await expectPickedUp(page, pickedUp);
    await stopTurn(request, convo.id);
  });

  test("a silent stream that cannot be asked about is reported", async ({ page, context, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await connectionDiesDuring(page, "api/chat", { chunks: 3, hangs: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Dors.");
    await expect(writing(page)).toBeVisible();
    await context.setOffline(true);

    await expect.poll(async () => {
      await phoneComesBack(page);
      return report(page).count();
    }, { timeout: 20_000, message: "still claiming to be receiving a reply" }).toBeGreaterThan(0);
    await expect(stopButton(page)).toBeHidden();
    await expect(looseWords(page), "the words that had arrived vanished").not.toHaveText("");

    await context.setOffline(false);
    await phoneComesBack(page);
    await expect(report(page), "the report stayed once it worked").toHaveCount(0);
    await stopTurn(request, convo.id);
  });

  test("continuing a reply through a lost connection shows nothing twice", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true, says: "bravo" });
    const target = convo.messages.at(-1);
    await connectionDiesDuring(page, "api/chat", { chunks: 3 });
    await page.goto(`/#/chat/${convo.id}`);
    await expect(page.locator(`[data-message-id="${target.id}"]`)).toBeVisible();

    const pickedUp = page.waitForRequest("**/turn/stream");
    await page.locator('button[title="Continue the reply"]').first().click({ force: true });
    await expectPickedUp(page, pickedUp);
    await expect(page.locator(`[data-message-id="${target.id}"]`),
      "the reply being continued went away").toBeVisible();
    expect((await page.locator("main").textContent())?.match(/bravo one/g)?.length,
      "the words so far are there twice").toBe(1);

    await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
    const after = (await conversation(request, convo.id)).messages;
    expect(after.length, "a reply was added instead of extended").toBe(convo.messages.length);
    await expect(page.locator(`[data-message-id="${target.id}"]`)).toContainText("endbravo");
    expect((await page.locator(`[data-message-id="${target.id}"]`).textContent())?.match(/endbravo/g)?.length,
      "the ending is there twice").toBe(1);
    await expect(retryButton(page)).toHaveCount(0);
  });
});

test.describe("a message that does not go", () => {
  const box = (page: Page) => page.locator("textarea").first();
  const badGateway = { status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" };

  test("sent with no connection, it is there on coming back", async ({ page, context, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto("/#/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();

    await context.setOffline(true);
    await send(page, "Hors ligne.");
    await expect(report(page).first()).toContainText("Evermind is not answering", { timeout: 20_000 });
    await expect(box(page), "the message was lost").toHaveValue("Hors ligne.");

    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await context.setOffline(false);
    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(box(page), "the message was lost on leaving").toHaveValue("Hors ligne.");

    await page.reload();
    await expect(box(page), "the message was lost on reloading").toHaveValue("Hors ligne.");
    await page.locator('button[title="Send"]').click();
    await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
      { timeout: 30_000 }).toBe(convo.messages.length + 2);
    await expect(box(page)).toHaveValue("");
  });

  test("turned away by something in between, it is in the box, and retrying sends that", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    const reply = convo.messages.at(-1);
    await page.route("**/api/chat", (route) => route.fulfill(badGateway));
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    await narrating(page);
    await send(page, "Passe donc.");
    await expect(report(page).first()).toBeVisible({ timeout: 20_000 });
    await expect(box(page), "the message was lost").toHaveValue("Passe donc.");
    await expect(narrationMode(page), "it came back as something else").toBeVisible();
    await page.unroute("**/api/chat");

    await box(page).fill("Passe donc, vite.");
    await retryButton(page).click();

    await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
      { timeout: 30_000 }).toBe(convo.messages.length + 2);
    const { messages } = await conversation(request, convo.id);
    expect(messages.at(-2).content, "not what the box held").toBe("Passe donc, vite.");
    expect(messages.at(-2).meta.mode, "not what it was meant as").toBe("narrate");
    expect(messages.find((m: { id: string }) => m.id === reply.id).variants.length,
      "asked for a new version of the reply before it").toBe(reply.variants.length);
    await expect(box(page)).toHaveValue("");
    await expect(report(page)).toHaveCount(0);
  });

  test("turned away after the page was left, it is there on coming back", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/chat", async (route) => {
      await released;
      await route.fulfill(badGateway);
    });
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    const turnedAway = page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.status() === 502);
    await send(page, "Passe donc.");
    await expect(box(page)).toHaveValue("");
    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    release();
    await turnedAway;
    await settled(page);

    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(box(page), "the message was lost").toHaveValue("Passe donc.");
  });

  test("retrying with the box emptied by hand asks for nothing", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.route("**/api/chat", (route) => route.fulfill(badGateway));
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Passe donc.");
    await expect(report(page).first()).toBeVisible({ timeout: 20_000 });
    await page.unroute("**/api/chat");
    await box(page).fill("");

    const posts = countingPosts(page);
    await retryButton(page).click();
    await expect(report(page), "still reporting it").toHaveCount(0);
    await settled(page);
    expect(posts(), "asked for something nobody wanted").toBe(0);
    expect((await conversation(request, convo.id)).messages.length).toBe(convo.messages.length);
  });

  test("refused for want of a session, it is there after signing back in", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.route("**/api/chat", (route) => route.fulfill({
      status: 401, contentType: "application/json",
      body: JSON.stringify({ error: "Locked.", kind: "locked" }),
    }));
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Me revoilà.");
    await expect(page, "nothing asked for the password").toHaveURL(/#\/login/);
    await settled(page);
    await page.unroute("**/api/chat");

    await page.goto(`/#/chat/${convo.id}`);
    await page.reload();
    await expect(box(page), "the message was lost").toHaveValue("Me revoilà.");
  });

  test("one that arrived, its answer being what was lost, does not stay to be sent twice", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await connectionDiesDuring(page, "api/chat", { chunks: 0, staysDead: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Arrivé quand même.");
    await expect(report(page).first()).toBeVisible({ timeout: 20_000 });
    await expect(box(page), "there is no telling yet, so it is kept").toHaveValue("Arrivé quand même.");

    await connectionBack(page);
    await phoneComesBack(page);
    await expect(box(page), "still offered for sending").toHaveValue("", { timeout: 15_000 });
    await stopTurn(request, convo.id);
    const said = (await conversation(request, convo.id)).messages
      .filter((m: { content: string }) => m.content === "Arrivé quand même.");
    expect(said.length).toBe(1);
  });

  test("an input that has just appeared writes nothing over the draft", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto("/#/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    const kept = await page.evaluate(async (id) => {
      location.hash = `#/chat/${id}`;
      while (!document.querySelector("textarea")) await new Promise((resolve) => setTimeout(resolve, 5));
      localStorage.setItem(`evermind:draft:${id}`, "Depuis l'autre onglet.");
      await new Promise((resolve) => setTimeout(resolve, 800));
      return localStorage.getItem(`evermind:draft:${id}`);
    }, convo.id);
    expect(kept).toBe("Depuis l'autre onglet.");
  });
});
