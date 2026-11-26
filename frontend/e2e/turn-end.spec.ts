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
