import { expect, test, type APIRequestContext, type BrowserContext, type Page, type Request } from "@playwright/test";
import { API } from "../playwright.config";
import {
  goWithinThePage, homeWifi, listen, phoneComesBack, report, retryButton, stopButton, writing,
} from "./connection";
import { chat, conversation, conversationWithReply, readOf, stopTurn, turnRunning } from "./fixtures";

/**
 * A phone on the home Wi-Fi, which can be slow, drop, or take seconds to come back after the
 * screen wakes: a message is never sent twice and never lost, the page never says something
 * false about a reply, and it ends showing what the server holds.
 */
test.setTimeout(120_000);

const box = (page: Page) => page.locator("textarea").first();
const send = async (page: Page, text: string) => {
  await box(page).fill(text);
  await page.locator('button[title="Send"]').click();
};
const said = async (request: APIRequestContext, id: string, text: string) =>
  (await conversation(request, id)).messages.filter((m: { content: string }) => m.content === text).length;
const notSent = (page: Page) => report(page).filter({ hasText: "was not sent" });
const notAnswering = (page: Page) => report(page).filter({ hasText: "Evermind is not answering" });
/** The side panel: over the conversation on a phone, once asked for; beside it on a wide screen. */
const openPanel = async (page: Page) => {
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
};

/** The page's request for a turn waits until `release` is called, then goes on in the way given. */
async function held(where: Page | BrowserContext, then: "continue" | "arrive and hang" = "continue") {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  await where.route("**/api/chat", async (route) => {
    if (!first) return route.continue();
    first = false;
    await released;
    if (then === "continue") return route.continue().catch(() => {});
    await route.fetch().catch(() => {}); // it arrives, and its answer never comes back
  });
  return release;
}

test.describe("a message that reaches Evermind late", () => {
  test("is followed once it gets there, and leaves the box", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    const release = await held(page);

    await send(page, "En retard.");
    await expect(notSent(page), "the server answered and the message is not there").toBeVisible({ timeout: 20_000 });
    await expect(box(page)).toHaveValue("En retard.");
    release();

    await expect(box(page), "still offered for sending").toHaveValue("", { timeout: 15_000 });
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
    await expect(report(page)).toHaveCount(0);
    expect(await said(request, convo.id, "En retard.")).toBe(1);
  });

  test("is found by asking again when its answer never comes back", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    const release = await held(page, "arrive and hang");

    await send(page, "Sans réponse.");
    await expect(notSent(page)).toBeVisible({ timeout: 20_000 });
    release();

    await expect(box(page), "still offered for sending").toHaveValue("", { timeout: 15_000 });
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
    await expect(report(page)).toHaveCount(0);
  });

  test("across a reload, is found as it gets there", async ({ page, context, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    const release = await held(context, "arrive and hang");
    await send(page, "Parti avant le rechargement.");
    await page.reload();
    await expect(box(page)).toHaveValue("Parti avant le rechargement.");
    await page.waitForLoadState("networkidle");

    release();

    await expect(box(page), "still offered for sending").toHaveValue("", { timeout: 15_000 });
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
    expect(await said(request, convo.id, "Parti avant le rechargement.")).toBe(1);
  });

  for (const then of ["breaks", "never comes"] as const) {
    test(`found by a read, is not said to be unsent when its answer ${then}`, async ({ page, request }) => {
      const convo = await conversationWithReply(request, { slowly: true });
      await page.goto(`/#/chat/${convo.id}`);
      await expect(box(page)).toBeVisible();
      const told = await listen(page);
      let lose = () => {};
      const lost = new Promise<void>((resolve) => { lose = resolve; });
      await page.route("**/api/chat", async (route) => {
        await route.fetch(); // Evermind has it
        await lost;
        if (then === "breaks") await route.abort("connectionreset");
      });
      const failed = then === "breaks"
        && page.waitForEvent("requestfailed", { predicate: (r) => r.url().endsWith("/api/chat") });

      const sentAt = Date.now();
      await send(page, "Arrivé quand même.");
      await expect.poll(() => turnRunning(request, convo.id)).toBe(true);
      await phoneComesBack(page);
      await expect(box(page), "a read did not find it").toHaveValue("", { timeout: 10_000 });
      lose();
      if (failed) await failed;
      // Long enough for the page to say something of it: past its patience, when it never comes.
      await page.waitForTimeout(failed ? 1_500 : Math.max(0, sentAt + 11_500 - Date.now()));

      await stopTurn(request, convo.id);
      await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
      expect(await told(), "said of a message on screen with its reply").toEqual([]);
      expect(await said(request, convo.id, "Arrivé quand même.")).toBe(1);
    });
  }

  test("said not to be sent, then found by another tab, is no longer said so", async ({ page, context, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    const release = await held(page, "arrive and hang");
    await send(page, "Trouvé par l'autre onglet.");
    await expect(notSent(page)).toBeVisible({ timeout: 20_000 });
    let readAgain = () => {};
    const readsBack = new Promise<void>((resolve) => { readAgain = resolve; });
    await page.route(`**/api/conversations/${convo.id}`, async (route) => {
      if (route.request().method() === "GET") await readsBack; // the other tab reads first
      await route.continue().catch(() => {});
    });

    release();
    await expect.poll(() => said(request, convo.id, "Trouvé par l'autre onglet.")).toBe(1);
    const other = await context.newPage();
    await other.goto(`/#/chat/${convo.id}`);
    await expect(box(other)).toHaveValue("");
    readAgain();

    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
    await expect(notSent(page), "said of a message on screen").toHaveCount(0);
    await expect(box(page)).toHaveValue("");
  });

  test("as a Regenerate, is followed once it gets there", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    const reply = convo.messages.at(-1);
    await page.goto(`/#/chat/${convo.id}`);
    await page.waitForLoadState("networkidle");
    const release = await held(page);

    // Once the page has stopped waiting and found nothing under way.
    const lookedAgain = page.waitForResponse((r) => r.request().method() === "GET"
      && r.url().endsWith(`/api/conversations/${convo.id}`), { timeout: 20_000 });
    await page.locator(`[data-message-id="${reply.id}"]`).getByTitle("Regenerate").click({ force: true });
    await lookedAgain;
    release();

    await expect(page.locator(`[data-message-id="${reply.id}"]`), "the new version never reached the screen")
      .toContainText("2/2", { timeout: 30_000 });
    await expect(report(page)).toHaveCount(0);
  });
});

test.describe("a message on its way", () => {
  test("is not offered again on a page left and come back to", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    const release = await held(page);
    await send(page, "Aller-retour.");

    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);
    await goWithinThePage(page, `/chat/${convo.id}`);
    await expect(box(page)).toHaveValue("Aller-retour.");
    await expect(box(page), "offered to be sent again").toHaveJSProperty("readOnly", true);
    release();

    await expect(box(page)).toHaveValue("", { timeout: 15_000 });
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
    await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length + 2);
    expect(await said(request, convo.id, "Aller-retour.")).toBe(1);
  });

  test("leaves the box of a second tab opened meanwhile once it gets there", async ({ page, context, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    const release = await held(page);
    await send(page, "Depuis l'onglet A.");
    const other = await context.newPage();
    await other.goto(`/#/chat/${convo.id}`);
    await expect(box(other)).toHaveValue("Depuis l'onglet A.");

    release();

    await expect(box(page)).toHaveValue("", { timeout: 15_000 });
    await expect(box(other), "the other tab offers it to be sent again").toHaveValue("");
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
    expect(await said(request, convo.id, "Depuis l'onglet A.")).toBe(1);
  });

  test("whose answer comes as its box is put back, leaves that box to be used", async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    // The answer to the page's request for a turn, once Evermind has it, is held until released.
    await page.addInitScript(() => {
      const real = window.fetch;
      const page_ = window as unknown as { __hold?: boolean; __release?: () => void };
      window.fetch = async (input, init) => {
        if (!page_.__hold || !String(input).endsWith("api/chat")) return real(input, init);
        page_.__hold = false;
        const answer = await real(input, init);
        const body = await answer.text();
        await new Promise<void>((resolve) => { page_.__release = resolve; });
        return new Response(body, { status: answer.status, headers: answer.headers });
      };
    });
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    await page.evaluate(() => { (window as unknown as { __hold: boolean }).__hold = true; });
    await send(page, "Tenu.");
    await page.waitForFunction(() => "__release" in window);
    await goWithinThePage(page, "/chat");
    await expect(page.locator("textarea")).toHaveCount(0);

    // As soon as the box is back in the page, before the page has run anything else.
    await page.evaluate(() => {
      new MutationObserver((_, observer) => {
        if (!document.querySelector("textarea")) return;
        observer.disconnect();
        (window as unknown as { __release: () => void }).__release();
      }).observe(document, { subtree: true, childList: true });
    });
    await goWithinThePage(page, `/chat/${convo.id}`);

    await expect(box(page)).toHaveValue("", { timeout: 15_000 });
    await expect(box(page), "still shown as sending").toBeEditable();
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
    await box(page).fill("La suite.");
    await expect(page.locator('button[title="Send"]')).toBeEnabled();
  });
});

test.describe("a message that does not get there", () => {
  test("sent with no network, it says the phone is offline, then that it was not sent", async ({ page, context, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    await context.setOffline(true);
    await send(page, "Hors ligne.");
    await expect(report(page).first()).toContainText("This device is offline", { timeout: 20_000 });

    await context.setOffline(false);
    await phoneComesBack(page);

    await expect(notSent(page), "Evermind answers again, and the message is not there").toBeVisible({ timeout: 15_000 });
    await expect(report(page)).toHaveCount(1);
    await expect(box(page)).toHaveValue("Hors ligne.");
    await page.locator('button[title="Send"]').click();
    await expect(box(page)).toHaveValue("", { timeout: 15_000 });
    await expect(report(page)).toHaveCount(0);
    expect(await said(request, convo.id, "Hors ligne.")).toBe(1);
  });

  test("refused while another reply is written, with the refusal lost, it says it was not sent", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    void request.post(`${API}/api/chat`, {
      data: { conversation_id: convo.id, mode: "send", content: "Depuis ailleurs.", message_mode: "say" },
    });
    await expect.poll(() => turnRunning(request, convo.id)).toBe(true);
    await page.route("**/api/chat", async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    });

    await send(page, "Refusé sans le savoir.");

    await expect(writing(page), "the page did not follow the other reply").toBeVisible({ timeout: 15_000 });
    await expect(notSent(page)).toBeVisible();
    await expect(notAnswering(page)).toHaveCount(0);
    await stopTurn(request, convo.id);
    await expect(notSent(page)).toBeVisible();
    await expect(box(page)).toHaveValue("Refusé sans le savoir.");
  });

  test("arrived with its answer lost, and its reply failed midway, says how and offers Retry", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { failsMidway: true });
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    await page.route("**/api/chat", async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    });

    await send(page, "Essaie.");

    await expect(report(page).first(), "the reason was lost").toContainText("connection to its server broke", { timeout: 30_000 });
    await expect(retryButton(page)).toBeVisible();
    await expect(box(page)).toHaveValue("");
  });
});

test.describe("an answer that never comes", () => {
  test("to Stop does not hold the page", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Arrête-toi.");
    await expect(writing(page)).toBeVisible();
    await page.route(`**/api/conversations/${convo.id}/turn`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await route.fetch(); // stopped, and the answer never comes back
    });
    const given = page.waitForEvent("requestfailed", {
      predicate: (r) => r.method() === "DELETE", timeout: 20_000,
    });

    await stopButton(page).click();

    await expect.poll(() => turnRunning(request, convo.id), { timeout: 10_000 }).toBe(false);
    const reply = (await conversation(request, convo.id)).messages.at(-1);
    await expect(page.locator(`[data-message-id="${reply.id}"]`)).toBeVisible();
    await given;
    await expect(report(page), "still said to be out of reach").toHaveCount(0, { timeout: 5_000 });
    await expect(stopButton(page)).toHaveCount(0);
  });

  test("to how the reply stands is given up on, and asked again", async ({ page, request }) => {
    const convo = await conversationWithReply(request, { slowly: true });
    await page.goto(`/#/chat/${convo.id}`);
    await send(page, "Réveil.");
    await expect(writing(page)).toBeVisible();
    let lost = true;
    await page.route(`**/api/conversations/${convo.id}/turn`, async (route) => {
      if (route.request().method() !== "GET" || !lost) return route.continue();
      lost = false;
      await route.fetch(); // the answer is lost on a connection that stays open
    });
    const given = page.waitForEvent("requestfailed", {
      predicate: (r) => r.url().endsWith("/turn"), timeout: 20_000,
    });

    await phoneComesBack(page);

    await given;
    await expect(writing(page), "the page stopped following the reply").toBeVisible();
    await expect(stopButton(page)).toBeVisible();
    await stopTurn(request, convo.id);
    const reply = (await conversation(request, convo.id)).messages.at(-1);
    await expect(page.locator(`[data-message-id="${reply.id}"]`)).toBeVisible();
    await expect(report(page)).toHaveCount(0);
  });

  test("to the side panel's read is given up on when it reads again, and when it goes", { tag: "@desktop" }, async ({ page, request }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    await openPanel(page);
    await page.waitForLoadState("networkidle");
    const isRead = (r: Request) => r.method() === "GET" && readOf(convo.id)(r.url());
    await page.route(readOf(convo.id), async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fetch().catch(() => {}); // read, and the answer never comes back
    });
    const wake = async () => {
      const sent = page.waitForRequest(isRead);
      await phoneComesBack(page);
      await sent;
    };
    await wake();

    const givenUp = page.waitForEvent("requestfailed", { predicate: isRead, timeout: 5_000 });
    await wake();
    await givenUp;

    const left = page.waitForEvent("requestfailed", { predicate: isRead, timeout: 5_000 });
    await goWithinThePage(page, "/chat");
    await left;
  });
});

test.describe("over a Wi-Fi that loses an answer and keeps its connection", () => {
  const overWifi = test.extend<{ wifi: Awaited<ReturnType<typeof homeWifi>> }>({
    wifi: async ({}, give) => {
      const wifi = await homeWifi();
      await give(wifi);
      await wifi.close();
    },
    proxy: async ({ wifi }, give) => give({ server: wifi.server }),
    // The other device's requests go straight to Evermind.
    request: async ({ playwright }, give) => {
      const direct = await playwright.request.newContext({ proxy: undefined });
      await give(direct);
      await direct.dispose();
    },
  });

  overWifi("the side panel's read holds no read of the page", { tag: "@desktop" }, async ({ page, request, wifi }) => {
    const convo = await conversationWithReply(request);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(box(page)).toBeVisible();
    await openPanel(page);
    await page.waitForLoadState("networkidle");
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Depuis le PC." });
    wifi.loseAnswerTo(`/api/conversations/${convo.id}`); // the panel's, which reads first on waking

    await phoneComesBack(page);

    await expect(page.locator("[data-message-id]"), "the page's read waited behind the panel's")
      .toHaveCount(convo.messages.length + 2, { timeout: 15_000 });
    await expect(report(page)).toHaveCount(0);
  });
});

test("a long conversation opens over a slow link, read once", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const long = "Je pousse la porte et j'entre dans la crypte, la lanterne levée. ".repeat(9000);
  await request.patch(`${API}/api/messages/${convo.messages[1].id}`, { data: { content: long } });
  await page.goto("/#/chat");
  await page.waitForLoadState("networkidle");
  const reads: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "GET" && r.url().endsWith(`/api/conversations/${convo.id}`)) reads.push(r.url());
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 0, downloadThroughput: 40 * 1024, uploadThroughput: -1,
  });

  await goWithinThePage(page, `/chat/${convo.id}`);

  await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length, { timeout: 40_000 });
  expect(reads, "read again before the first had all come").toHaveLength(1);
  await expect(report(page)).toHaveCount(0);
});

test("a phone waking on a quiet conversation while its network comes back raises no alarm", async ({ page, context, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);
  await page.waitForLoadState("networkidle");
  const told = await listen(page);

  await context.setOffline(true);
  await phoneComesBack(page);
  await page.waitForTimeout(3000);
  await context.setOffline(false);
  await phoneComesBack(page);
  await page.waitForTimeout(3000);

  expect(await told()).toEqual([]);

  await context.setOffline(true);
  await phoneComesBack(page);
  await expect(report(page).first(), "a phone with no network is said to be one")
    .toContainText("This device is offline", { timeout: 15_000 });
  await context.setOffline(false);
  await phoneComesBack(page);
  await expect(report(page)).toHaveCount(0, { timeout: 15_000 });
});
