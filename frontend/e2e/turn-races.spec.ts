import { expect, test, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import {
  connectionBack, connectionDiesDuring, countingPosts, countingStreams, expectPickedUp, goWithinThePage,
  phoneComesBack, report, retryButton, stopButton, writing,
} from "./connection";
import { chat, conversation, conversationWithReply, stopTurn, turnRunning } from "./fixtures";

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

/** The server gets what the page asks for a turn, and the answer is lost on its way back. */
const answerLost = (page: Page) => page.route("**/api/chat", async (route) => {
  await route.fetch();
  await route.abort("connectionreset");
});

/** A Regenerate that failed, reported, with the model working again. */
async function regenerateFailed(page: Page, request: Parameters<typeof turnRunning>[0], next = "") {
  const convo = await conversationWithReply(request, { failing: true });
  await page.goto(`/#/chat/${convo.id}`);
  // Once the page has settled: a name arriving moves the button from under a click.
  await page.waitForLoadState("networkidle");
  await page.locator('button[title="Regenerate"]').first().click({ force: true });
  await expect(report(page).first()).toContainText("told to fail", { timeout: 20_000 });
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: next } });
  return convo;
}

test.describe("Stop", () => {
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

  test("a stop whose answer was lost is not reported once the reply is seen stopped", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Vas-y.");
    await expect(writing(page)).toBeVisible();
    await page.route(`**/api/conversations/${convo.id}/turn`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await route.fetch();
      await route.abort("connectionreset");
    });

    await stopButton(page).click();

    await expect.poll(() => turnRunning(request, convo.id), { timeout: 10_000 }).toBe(false);
    const reply = (await conversation(request, convo.id)).messages.at(-1);
    await expect(page.locator(`[data-message-id="${reply.id}"]`)).toBeVisible();
    await expect(report(page), "still said to be out of reach once it had answered").toHaveCount(0);
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
    await expect(page.locator("textarea").first(), "it waits in the box").toHaveValue("Et ceci ?");
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
});

test.describe("what another device did", () => {
  test("is on screen once the phone wakes", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    await page.waitForLoadState("networkidle");
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Depuis le PC." });

    await phoneComesBack(page);

    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
    await expect(page.getByText("Depuis le PC.")).toBeVisible();
  });

  test("is on screen once the window, visible all along, is come back to", { tag: "@desktop" }, async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    await page.waitForLoadState("networkidle");
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Depuis le téléphone." });

    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
    await expect(page.getByText("Depuis le téléphone.")).toBeVisible();
  });

  test("beginning between the page's question and its read is followed", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    let first = true;
    await page.route(`**/api/conversations/${convo.id}`, async (route) => {
      if (route.request().method() !== "GET" || !first) return route.continue();
      first = false;
      void elsewhere(request, convo.id, { mode: "send", content: "Envoyé d'ailleurs." });
      await expect.poll(() => turnRunning(request, convo.id)).toBe(true);
      await route.continue();
    });

    await page.goto(`/#/chat/${convo.id}`);

    await expect(writing(page), "the page did not follow it").toBeVisible({ timeout: 15_000 });
    await expect(report(page), "said not to have arrived").toHaveCount(0);
    await stopTurn(request, convo.id);
    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
    await expect(report(page)).toHaveCount(0);
  });
});

test.describe("leaving and coming back", () => {
  test("a model failing while away is reported on coming back", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { failing: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Echoue.");
    await expect(stopButton(page)).toBeVisible();
    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 15_000 }).toBe(false);

    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(report(page).first(), "the reason was lost").toContainText("told to fail");
  });
});

test.describe("what is asked of a connection that does not answer", () => {
  test("continuing a reply through a lost connection shows nothing twice", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true, says: "bravo" });
    const target = convo.messages.at(-1);
    await connectionDiesDuring(page, "/turn/stream", { chunks: 3 });
    const streams = countingStreams(page);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(page.locator(`[data-message-id="${target.id}"]`)).toBeVisible();

    await page.locator('button[title="Continue the reply"]').first().click({ force: true });
    await expectPickedUp(page, expect.poll(streams).toBeGreaterThan(1));
    // Drawn whole, from its words as they arrive, in place of the message.
    await expect(page.locator(`[data-message-id="${target.id}"]`)).toHaveCount(0);
    expect((await page.locator("main").textContent())?.match(/bravo one/g)?.length,
      "the words so far are there twice, or not at all").toBe(1);

    await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
    const after = (await conversation(request, convo.id)).messages;
    expect(after.length, "a reply was added instead of extended").toBe(convo.messages.length);
    await expect(page.locator(`[data-message-id="${target.id}"]`)).toContainText("endbravo");
    expect((await page.locator(`[data-message-id="${target.id}"]`).textContent())?.match(/endbravo/g)?.length,
      "the ending is there twice").toBe(1);
    await expect(retryButton(page)).toHaveCount(0);
  });

  test("a Regenerate whose answer was lost is followed, and how it ended is said", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { failing: true });
    await answerLost(page);
    await page.goto(`/#/chat/${convo.id}`);
    await page.waitForLoadState("networkidle");

    await page.locator('button[title="Regenerate"]').first().click({ force: true });

    await expect(report(page).first(), "the reason was lost").toContainText("told to fail", { timeout: 20_000 });
    await expect(report(page).filter({ hasText: "Evermind is not answering" }),
      "still said to be out of reach once it had answered").toHaveCount(0);
    await expect(retryButton(page)).toBeVisible();
  });

  test("an edit saved while the reply's ending is on its way leaves the reply on screen", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Vas-y.");
    await expect(writing(page)).toBeVisible();
    const earlier = page.locator(`[data-message-id="${convo.messages[1].id}"]`);
    await earlier.getByTitle("Edit").click();
    await earlier.locator("textarea").fill("Corrigé.");

    // The conversation read as the reply ends is slow to come, as on a phone's link.
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let reading = () => {};
    const read = new Promise<void>((resolve) => { reading = resolve; });
    await page.route(`**/api/conversations/${convo.id}`, async (route) => {
      if (route.request().method() === "GET") {
        reading();
        await released;
      }
      await route.continue();
    });
    await stopTurn(request, convo.id);
    await read;
    await earlier.getByRole("button", { name: "Save" }).click();
    await expect(earlier).toContainText("Corrigé.");
    release();

    const reply = (await conversation(request, convo.id)).messages.at(-1);
    await expect(page.locator(`[data-message-id="${reply.id}"]`), "the reply never reached the screen").toBeVisible();
    await expect(report(page)).toHaveCount(0);
  });
});

test.describe("a failure, once something else is written", () => {
  test("is not said again under a reply asked for elsewhere", async ({ page, request }) => {
    const convo = await regenerateFailed(page, request, "SLOWLY");
    void elsewhere(request, convo.id, { mode: "send", content: "Depuis ailleurs." });
    await expect.poll(() => turnRunning(request, convo.id)).toBe(true);
    await phoneComesBack(page);
    await expect(writing(page), "the page did not follow it").toBeVisible();
    await stopTurn(request, convo.id);

    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
    await expect(report(page), "the failure came back under the reply").toHaveCount(0);
    await expect(retryButton(page)).toHaveCount(0);
  });

  test("is not said again under a reply written elsewhere while the page slept", async ({ page, request }) => {
    const convo = await regenerateFailed(page, request);
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Depuis ailleurs." });

    await phoneComesBack(page);

    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
    await expect(report(page), "the failure came back under the reply").toHaveCount(0);
    await expect(retryButton(page)).toHaveCount(0);
  });

  test("is not said again under the reply to a message whose answer was lost", async ({ page, request }) => {
    const convo = await regenerateFailed(page, request);
    await answerLost(page);

    await send(page, "Arrivé.");

    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2, { timeout: 30_000 });
    await expect(page.locator("textarea").first()).toHaveValue("");
    await expect(report(page), "the failure came back under the reply").toHaveCount(0);
    await expect(retryButton(page)).toHaveCount(0);
  });
});

test.describe("Retry on what was asked for by hand", () => {
  test("a Regenerate that failed is regenerated", async ({ page, request }) => {
    const asked: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/chat")) asked.push(r.postDataJSON().mode);
    });
    const convo = await regenerateFailed(page, request);
    await retryButton(page).click();
    await expect(report(page)).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
    expect(asked).toEqual(["regenerate", "regenerate"]);
  });
});

test.describe("a message that does not go", () => {
  const box = (page: Page) => page.locator("textarea").first();
  const badGateway = { status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" };
  const said = async (request: Parameters<typeof turnRunning>[0], id: string, text: string) =>
    (await conversation(request, id)).messages.filter((m: { content: string }) => m.content === text).length;

  test("sent with no connection, it is there on coming back", async ({ page, context, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto("/#/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();

    await context.setOffline(true);
    await send(page, "Hors ligne.");
    await expect(report(page).first()).toContainText("This device is offline", { timeout: 20_000 });
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

  test("turned away by something in between, it is in the box as what it was meant as, and Send sends it", async ({ page, request }) => {
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
    await expect(retryButton(page), "Send is what sends it").toHaveCount(0);
    await page.unroute("**/api/chat");

    await page.locator('button[title="Send"]').click();

    await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
      { timeout: 30_000 }).toBe(convo.messages.length + 2);
    const { messages } = await conversation(request, convo.id);
    expect(messages.at(-2).content).toBe("Passe donc.");
    expect(messages.at(-2).meta.mode, "not what it was meant as").toBe("narrate");
    expect(messages.find((m: { id: string }) => m.id === reply.id).variants.length,
      "asked for a new version of the reply before it").toBe(reply.variants.length);
    await expect(box(page)).toHaveValue("");
    await expect(report(page)).toHaveCount(0);
  });

  test("two quick presses of Send send it once", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.route("**/api/chat", (route) => route.fulfill(badGateway));
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Deux fois ?");
    await expect(report(page).first()).toBeVisible({ timeout: 20_000 });
    await page.unroute("**/api/chat");

    const posts = countingPosts(page);
    await page.locator('button[title="Send"]').dblclick();
    await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
      { timeout: 30_000 }).toBe(convo.messages.length + 2);
    expect(posts()).toBe(1);
    expect(await said(request, convo.id, "Deux fois ?")).toBe(1);
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

  /** A message that got there, with the answer lost on the way back, and nothing getting through
   *  until the connection is back. */
  async function sentWithTheAnswerLost(page: Page, id: string, text: string) {
    await connectionDiesDuring(page, "api/chat", { chunks: 0, staysDead: true });
    await page.goto(`/#/chat/${id}`);
    await send(page, text);
    await expect(report(page).first()).toBeVisible({ timeout: 20_000 });
    await expect(box(page), "there is no telling yet, so it is kept").toHaveValue(text);
  }

  test("one that arrived and was answered leaves the box by itself, and is said once", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await sentWithTheAnswerLost(page, convo.id, "Arrivé quand même.");
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);

    const posts = countingPosts(page);
    await connectionBack(page); // and nothing says so: the page asks again by itself

    await expect(box(page), "still offered for sending").toHaveValue("", { timeout: 15_000 });
    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
    await expect(report(page)).toHaveCount(0);
    expect(await said(request, convo.id, "Arrivé quand même."), "sent twice").toBe(1);
    expect(posts(), "there was nothing to ask for").toBe(0);
  });

  test("one that arrived with no reply says why, and Retry gets it one without saying it twice", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { failing: true });
    const reply = convo.messages.at(-1);
    await sentWithTheAnswerLost(page, convo.id, "Réponds.");
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
    await connectionBack(page);
    await expect(box(page)).toHaveValue("", { timeout: 15_000 });
    await expect(report(page).first(), "the reason was lost").toContainText("told to fail");
    await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });

    await retryButton(page).click();

    await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
      { timeout: 30_000 }).toBe(convo.messages.length + 2);
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
    const { messages } = await conversation(request, convo.id);
    expect(messages.at(-1).role, "no reply").toBe("assistant");
    expect(await said(request, convo.id, "Réponds."), "sent twice").toBe(1);
    expect(messages.find((m: { id: string }) => m.id === reply.id).variants.length,
      "asked for a new version of the reply before it").toBe(reply.variants.length);
  });

  test("a tab that goes before a message has got anywhere has it back", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.route("**/api/chat", () => {}); // and that is the last that is heard of it
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    await narrating(page);
    await send(page, "Trop tard.");
    await expect(box(page), "it waits in the box").toHaveValue("Trop tard.");
    await expect(page.locator('button[title="Send"]')).toBeDisabled();

    await page.reload();

    await expect(box(page), "the message was lost").toHaveValue("Trop tard.");
    await expect(narrationMode(page), "it came back as something else").toBeVisible();
    await page.unroute("**/api/chat");
    await page.locator('button[title="Send"]').click();
    await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
      { timeout: 30_000 }).toBe(convo.messages.length + 2);
    expect(await said(request, convo.id, "Trop tard.")).toBe(1);
    await expect(box(page)).toHaveValue("");
  });
});
