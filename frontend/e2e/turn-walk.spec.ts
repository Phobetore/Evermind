import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { looseWords, phoneComesBack, report, stopButton } from "./connection";
import { chat, conversation, conversationWithReply, makeConversation, stopTurn, turnRunning } from "./fixtures";

/**
 * A walk through what a phone does to a reply, as the design was first tried on one: the
 * page asks how the reply stands, reads, follows the words, and asks again whenever anything
 * may have broken that. Each step says what it checks.
 */
test.setTimeout(120_000);

const box = (page: Page) => page.locator("textarea").first();
const words = async (page: Page) => ((await looseWords(page).textContent()) ?? "").replaceAll("*", "").trim();
const count = (text: string) => text.split(/\s+/).filter(Boolean).length;

async function send(page: Page, text: string) {
  await box(page).fill(text);
  await page.locator('button[title="Send"]').click();
}

async function wordsAtLeast(page: Page, n: number) {
  await expect.poll(async () => count(await words(page)), { timeout: 20_000 }).toBeGreaterThanOrEqual(n);
  return words(page);
}

async function said(request: APIRequestContext, id: string, text: string) {
  return (await conversation(request, id)).messages.filter((m: { content: string }) => m.content === text).length;
}

test("a reply followed from one page and another, offline and back, then stopped", async ({ browser, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  const first: BrowserContext = await browser.newContext();
  const page = await first.newPage();
  await page.goto(`/#/chat/${convo.id}`);
  await send(page, "Bonjour");
  const before = await wordsAtLeast(page, 3); // A: the words appear as they arrive
  await first.close();

  const second = await browser.newContext();
  const again = await second.newPage();
  await again.goto(`/#/chat/${convo.id}`);
  const after = await wordsAtLeast(again, count(before) + 1);
  expect(after.startsWith(before.slice(0, 20)), "A: reopened, all of it, and further on").toBe(true);
  await expect(stopButton(again), "A: reopened, stop is offered").toBeVisible();

  await second.setOffline(true);
  await phoneComesBack(again);
  await expect(report(again).first(), "B: offline, it says so").toBeVisible({ timeout: 15_000 });
  const kept = await words(again);
  expect(count(kept), "B: offline, the words stay").toBeGreaterThanOrEqual(count(after));
  await second.setOffline(false);
  await expect(report(again), "B: back, the report goes by itself").toHaveCount(0, { timeout: 15_000 });
  const resumed = await wordsAtLeast(again, count(kept) + 1); // B: back, the words carry on

  await phoneComesBack(again);
  const woken = await wordsAtLeast(again, count(resumed));
  expect(woken.startsWith(resumed.slice(0, 40)), "B: woken mid-reply, nothing twice, nothing back").toBe(true);

  await stopButton(again).click();
  await expect(stopButton(again)).toBeHidden();
  const stopped = (await conversation(request, convo.id)).messages.at(-1);
  expect(stopped.role).toBe("assistant");
  expect(count(stopped.content.replaceAll("*", "")), "G: a stop keeps every word").toBeGreaterThanOrEqual(count(woken));
  await send(again, "Et ensuite");
  await expect.poll(() => said(request, convo.id, "Et ensuite"), { message: "G: stopped, the next message goes" }).toBe(1);
  await stopTurn(request, convo.id);
  await second.close();
});

test("a message sent with no connection, then a regeneration followed through a reload", async ({ page, context, request }) => {
  const convo = await makeConversation(request);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(box(page)).toBeVisible();
  await context.setOffline(true);
  await send(page, "Hors ligne");
  await expect(report(page).first(), "C: offline, it says so").toBeVisible({ timeout: 20_000 });
  await expect(box(page), "C: offline, the message is still in the box").toHaveValue("Hors ligne");
  await context.setOffline(false);
  await page.reload();
  await expect(box(page), "C: reloaded, still in the box").toHaveValue("Hors ligne");
  await page.locator('button[title="Send"]').click();
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
  const rows = (await conversation(request, convo.id)).messages;
  expect(await said(request, convo.id, "Hors ligne"), "C: sent once").toBe(1);
  await expect(box(page), "C: sent, the box is empty").toHaveValue("");
  await expect(page.locator("[data-message-id]"), "C: the reply is on screen").toHaveCount(rows.length);
  await expect(report(page), "C: and nothing is reported").toHaveCount(0);

  const reply = rows.at(-1);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "SLOWLY" } });
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.locator(`[data-message-id="${reply.id}"]`).getByTitle("Regenerate").click({ force: true });
  await wordsAtLeast(page, 2);
  await expect(page.locator(`[data-message-id="${reply.id}"]`), "E: regenerating, the old one is out of the way").toHaveCount(0);
  await page.reload();
  await wordsAtLeast(page, 2);
  await expect(page.locator(`[data-message-id="${reply.id}"]`), "E: reloaded mid-regeneration, still only the new one").toHaveCount(0);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 60_000 }).toBe(false);
  const regenerated = (await conversation(request, convo.id)).messages.at(-1);
  expect(regenerated.variants, "E: ended, two versions").toHaveLength(2);
  await expect(page.locator(`[data-message-id="${reply.id}"]`), "E: the new one on screen").toContainText("2/2");
});

test("a message that arrived with its answer lost is said once, and leaves the box", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(box(page)).toBeVisible();
  await page.route("**/api/chat", async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
  await send(page, "Arrivé");
  await expect.poll(() => said(request, convo.id, "Arrivé"), { timeout: 20_000 }).toBe(1);
  await page.unroute("**/api/chat");
  await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
  await phoneComesBack(page);

  await expect(box(page), "D: answer lost, not offered again").toHaveValue("", { timeout: 15_000 });
  expect(await said(request, convo.id, "Arrivé"), "D: answer lost, said once").toBe(1);
  await expect(page.locator("[data-message-id]"), "D: answer lost, the reply on screen")
    .toHaveCount((await conversation(request, convo.id)).messages.length);
});

test("a model failing with no page open is reported with its reason", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { failing: true });
  await chat(request, { conversation_id: convo.id, mode: "send", content: "Échoue", client_id: "x1" });
  await page.goto(`/#/chat/${convo.id}`);
  await expect(report(page).first(), "H: the reason, not that the reply did not arrive").toContainText("told to fail");
});

test("another conversation goes while a reply is written, and the first is still arriving", async ({ page, request }) => {
  const a = await conversationWithReply(request, { slowly: true });
  const b = await makeConversation(request);
  await page.goto(`/#/chat/${a.id}`);
  await send(page, "Longue");
  await wordsAtLeast(page, 1);
  await page.goto(`/#/chat/${b.id}`);
  await send(page, "Courte");
  await expect.poll(async () => (await conversation(request, b.id)).messages.at(-1).role,
    { timeout: 30_000, message: "I: another conversation goes meanwhile" }).toBe("assistant");
  await page.goto(`/#/chat/${a.id}`);
  await wordsAtLeast(page, 2); // I: back to the first, still arriving
  await stopTurn(request, a.id);
});
