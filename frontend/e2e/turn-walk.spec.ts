import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { looseWords, phoneComesBack, report, stopButton } from "./connection";
import { conversation, conversationWithReply, stopTurn } from "./fixtures";

/**
 * A walk through what a phone does to a reply: the page asks how the reply stands, reads,
 * follows the words, and asks again whenever anything may have broken that. Each step says
 * what it checks.
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
  expect(count(stopped.content.replaceAll("*", "")), "C: a stop keeps every word").toBeGreaterThanOrEqual(count(woken));
  await send(again, "Et ensuite");
  await expect.poll(() => said(request, convo.id, "Et ensuite"), { message: "C: stopped, the next message goes" }).toBe(1);
  await stopTurn(request, convo.id);
  await second.close();
});
