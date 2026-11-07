import { expect, test, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { goWithinThePage, phoneComesBack, report, stopButton, writing } from "./connection";
import { conversation, conversationWithReply, stopTurn, turnRunning } from "./fixtures";

/**
 * A phone on the home Wi-Fi, which can be slow, drop, or take seconds to come back after the
 * screen wakes: a message is never sent twice and never lost, the page never says something
 * false about a reply, and it ends showing what the server holds.
 */
test.setTimeout(120_000);

const send = async (page: Page, text: string) => {
  await page.locator("textarea").first().fill(text);
  await page.locator('button[title="Send"]').click();
};

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
