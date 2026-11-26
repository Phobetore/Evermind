import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { MOCK, addModel, chat, conversationWithReply, makeConversation, replyEnds, stopTurn } from "./fixtures";

/**
 * A reply on a phone, over a slow link: the end of the turn carries what the way's chip shows next
 * and what the conversation has cost, so that the page asks for neither once the reply is in. An
 * open sheet still reads the whole, as nothing else reads its rows while it stays open.
 */

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const chipOf = (page: Page) => page.locator("[data-status-row]").getByRole("button", { name: /^Way to play:/ });
const sheetOf = (page: Page) => page.getByRole("dialog", { name: "Way to play" });

/** Every address the page asks for from now on, until the list is read. */
function asked(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  return urls;
}

const outlookOf = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`${API}/api/conversations/${id}/outlook?only=current`)).json()).current;

test("a reply asks for no outlook of its own", async ({ page, request }) => {
  test.setTimeout(120_000);
  const small = await addModel(request, {
    base_url: MOCK, model: `turn-end-${stamp()}`, name: `Small ${stamp()}`, changes: { context_own: 4096 },
  });
  try {
    // A short story that a 4,096 AI rereads whole under Immersive; the reply asked for from the
    // page, with the long message before it, takes the story past what it reads at once.
    const convo = await makeConversation(request);
    await request.patch(`${API}/api/conversations/${convo.id}`, {
      data: { model_id: small.id, play_style: "immersive", author_note: "MOCK_SAYS_tide" },
    });
    for (let turn = 0; turn < 3; turn++) {
      await chat(request, { conversation_id: convo.id, mode: "send", content: `${turn}. The tide came in.` });
    }
    const before = await outlookOf(request, convo.id);
    expect([before.messages_included, before.messages_total]).toEqual([7, 7]);

    await page.goto(`/#/chat/${convo.id}`);
    await expect(chipOf(page)).toHaveText("Immersive");

    const urls = asked(page);
    const ended = replyEnds(page, convo.id);
    await page.locator("textarea").first().fill("The rain kept on over the harbour and nobody spoke of the ship. ".repeat(60));
    await page.locator('button[title="Send"]').click();
    await ended;
    // What the end carried: the chip says the story no longer fits, and nothing asked for it.
    const after = await outlookOf(request, convo.id);
    expect(after.messages_total).toBe(9);
    expect(after.messages_included).toBeLessThan(9);
    await expect(chipOf(page)).toHaveText(`Immersive · rereads ${after.messages_included} of 9`);
    expect(urls.filter((url) => url.includes("/outlook") || url.includes("/api/spending"))).toEqual([]);
  } finally {
    await request.delete(`${API}/api/models/${small.id}`);
  }
});

test("a sheet open at the turn's end still reads the whole", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Slowly now.");
  await page.locator('button[title="Send"]').click();
  await expect(page.locator('button[title="Stop generation"]')).toBeVisible();
  await chipOf(page).click();
  // The rows come with the whole outlook, read as the sheet opens.
  await expect(sheetOf(page).getByRole("listitem")).toHaveCount(4);

  const whole = page.waitForRequest((r) => {
    const url = new URL(r.url());
    return url.pathname.endsWith(`/api/conversations/${convo.id}/outlook`) && !url.searchParams.has("only");
  });
  await stopTurn(request, convo.id);
  await whole;
});

test("a way changed elsewhere while the link was lost is the way shown once it comes back", async ({ page, request }) => {
  test.setTimeout(90_000);
  const convo = await conversationWithReply(request, { slowly: true });
  await page.goto(`/#/chat/${convo.id}`);
  await expect(chipOf(page)).toHaveText("Balanced");
  await page.locator("textarea").first().fill("Slowly now.");
  await page.locator('button[title="Send"]').click();
  await expect(page.locator('button[title="Stop generation"]')).toBeVisible();

  // A phone on a bad link: nothing of the conversation reaches it, while another window stops the
  // reply and plays it another way. That way moves no revision of the story.
  let cut = true;
  await page.route(`**/api/conversations/${convo.id}**`, (route) =>
    cut ? route.abort("internetdisconnected") : route.continue());
  await stopTurn(request, convo.id);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { play_style: "immersive" } });
  cut = false;

  await expect(chipOf(page)).toHaveText("Immersive", { timeout: 30_000 });
  await expect(page.locator('button[title="Stop generation"]')).toBeHidden();
  // Still so once the page has heard the end and read again what it would.
  await page.waitForLoadState("networkidle");
  await expect(chipOf(page)).toHaveText("Immersive");
});

test("a page opening on a turn already over reads the chip's pair itself", async ({ page, request }) => {
  // The end the server holds may predate what came after the reply on its own, a memory pass: a
  // page that did not see the turn run reads what the next turn reads, once.
  const convo = await makeConversation(request);
  await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
  const urls = asked(page);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(chipOf(page)).toHaveText("Balanced");
  const short = () => urls.filter((url) => url.includes("/outlook?only=current")).length;
  await expect.poll(short).toBe(1);
  await page.waitForLoadState("networkidle");
  expect(short()).toBe(1);
});

test("a short read sent before the end does not overwrite what the end carried", async ({ page, request }) => {
  test.setTimeout(120_000);
  const small = await addModel(request, {
    base_url: MOCK, model: `turn-end-${stamp()}`, name: `Small ${stamp()}`, changes: { context_own: 4096 },
  });
  try {
    const convo = await makeConversation(request);
    await request.patch(`${API}/api/conversations/${convo.id}`, {
      data: { model_id: small.id, play_style: "immersive", author_note: "MOCK_SAYS_tide" },
    });
    for (let turn = 0; turn < 3; turn++) {
      await chat(request, { conversation_id: convo.id, mode: "send", content: `${turn}. The tide came in.` });
    }

    // The page's first short read is answered by the server at once, on the story before the
    // reply, and reaches the page only after the reply's end: a slow link.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let late: Promise<unknown> | null = null;
    await page.route(`**/api/conversations/${convo.id}/outlook?only=current`, async (route) => {
      if (late) return route.continue();
      const answered = route.fetch();
      late = page.waitForResponse((r) => r.request() === route.request());
      const response = await answered;
      await released;
      await route.fulfill({ response });
    });
    await page.goto(`/#/chat/${convo.id}`);
    await expect(chipOf(page)).toHaveText("Immersive");
    await expect.poll(() => late !== null).toBe(true);

    const ended = replyEnds(page, convo.id);
    await page.locator("textarea").first().fill("The rain kept on over the harbour and nobody spoke of the ship. ".repeat(60));
    await page.locator('button[title="Send"]').click();
    await ended;
    const after = await outlookOf(request, convo.id);
    await expect(chipOf(page)).toHaveText(`Immersive · rereads ${after.messages_included} of 9`);

    release();
    await late;
    await page.waitForLoadState("networkidle");
    await expect(chipOf(page)).toHaveText(`Immersive · rereads ${after.messages_included} of 9`);
  } finally {
    await request.delete(`${API}/api/models/${small.id}`);
  }
});
