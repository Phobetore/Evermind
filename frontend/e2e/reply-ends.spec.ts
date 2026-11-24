import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { addModel, chat, conversationWithReply, MOCK, replyEnds } from "./fixtures";

/**
 * A reply that ends without what was asked for says why, as a person on a phone reads it
 * (see scripts/mock_llm.py): a model that reasoned through all its room and wrote nothing, a
 * server that withheld the answer and said so, and a reply cut a few words in by the connection's
 * max tokens, which Continue carries on.
 */

test.use({ viewport: { width: 390, height: 844 } });

/**
 * An AI of the conversation's own, so that what is set here, or what it learns (that its model
 * reasons, which stops its ceiling being sent), never reaches the one every other test uses.
 */
async function ownAi(request: APIRequestContext, conversationId: string, changes?: Record<string, unknown>) {
  const own = await addModel(request, {
    base_url: MOCK, model: `reply-ends-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, changes,
  });
  await request.patch(`${API}/api/conversations/${conversationId}`, { data: { model_id: own.id } });
}

/**
 * A conversation with one exchange in it, its model now told to end the next reply `how`;
 * `changes`: on an AI of its own.
 */
async function endingWith(request: APIRequestContext, how: string, changes?: Record<string, unknown>) {
  const convo = await conversationWithReply(request);
  if (changes) await ownAi(request, convo.id, changes);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: how } });
  return convo;
}

async function sendFromTheBox(page: Page, id: string) {
  await page.goto(`/#/chat/${id}`);
  await page.locator("textarea").first().fill("What now?");
  const ends = replyEnds(page, id);
  await page.locator('button[title="Send"]').click();
  await ends;
}

async function noSidewaysScroll(page: Page) {
  const wider = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(wider, "the page scrolls sideways").toBeLessThanOrEqual(0);
}

test("a model that only reasoned says so, with what to change", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_REASONS_ONLY", {});
  await sendFromTheBox(page, convo.id);

  const said = page.getByRole("alert");
  await expect(said).toHaveText(
    "The model spent its whole answer thinking and wrote nothing. Raise the connection's max tokens, or use a model that does not think as long.",
  );
  await expect(page.getByText("The model returned an empty reply.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await noSidewaysScroll(page);
});

test("an answer its server withheld quotes the server's word", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_WITHHOLDS");
  await sendFromTheBox(page, convo.id);

  await expect(page.getByRole("alert")).toHaveText(
    'The model\'s server withheld the answer ("content_filter"). Try again, or change the model or the provider.',
  );
  await noSidewaysScroll(page);
});

test("a reply cut by the max tokens says why under it, and Continue carries it to its end", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_HITS_CEILING", { reply_cap: { mode: "fixed", tokens: 1024 } });
  await sendFromTheBox(page, convo.id);

  const reply = page.locator("[data-message-id]").last();
  const line = reply.locator("[data-ceiling]");
  await expect(line).toHaveText(
    "Cut short: this reply reached the connection's limit of 1,024 tokens, and the model's thinking counts toward it. Continue the reply to carry on.",
  );
  // Said once as the reply comes in, with the reply; not a failure, and not "interrupted".
  await expect(page.getByRole("status")).toContainText("reached the connection's limit of 1,024 tokens");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(reply).not.toContainText("interrupted");
  await noSidewaysScroll(page);
  const before = (await reply.locator(".min-w-0 > .mt-1").innerText()).trim();

  // The model has room again: Continue ends the reply as a reply ends.
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });
  await page.waitForLoadState("networkidle");
  const ends = replyEnds(page, convo.id);
  await reply.locator('button[title="Continue the reply"]').click({ force: true });
  await ends;

  await expect(line).toHaveCount(0);
  await expect(reply.locator(".min-w-0 > .mt-1")).toContainText(before);
  expect((await reply.locator(".min-w-0 > .mt-1").innerText()).trim().length).toBeGreaterThan(before.length);
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.messages.at(-1).meta.ceiling).toBeUndefined();
  await noSidewaysScroll(page);
});

test("a reply cut at a ceiling of its ai's offers to let Evermind set it", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_HITS_CEILING", { reply_cap: { mode: "fixed", tokens: 1024 } });
  const aiId = (await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).model_id;
  await sendFromTheBox(page, convo.id);

  const reply = page.locator("[data-message-id]").last();
  const lift = reply.getByRole("button", { name: "Let Evermind set it" });
  await expect(reply.locator("[data-ceiling]")).toContainText("1,024 tokens");
  await expect(lift).toBeVisible();
  await noSidewaysScroll(page);
  await lift.click();
  await expect(page.locator("[data-chat-toast]")).toContainText("no longer has a ceiling of its own: Evermind keeps the room it needs.");
  const ais = await (await request.get(`${API}/api/models`)).json();
  expect(ais.find((ai: { id: string }) => ai.id === aiId).reply_cap.mode).toBe("auto");
  // The line stays, for what it says of this reply, without its button.
  await expect(reply.locator("[data-ceiling]")).toBeVisible();
  await expect(lift).toHaveCount(0);

  // Continue ends the reply as it does today.
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });
  await page.waitForLoadState("networkidle");
  const ends = replyEnds(page, convo.id);
  await reply.locator('button[title="Continue the reply"]').click({ force: true });
  await ends;
  await expect(reply.locator("[data-ceiling]")).toHaveCount(0);
});

test("a reply cut where its ai sends no ceiling offers nothing to lift", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_HITS_CEILING", { reply_cap: { mode: "unsent" } });
  await sendFromTheBox(page, convo.id);

  const reply = page.locator("[data-message-id]").last();
  await expect(reply.locator("[data-ceiling]")).toHaveText(
    "Cut short: this reply reached the most the model's server lets it write, and the model's thinking counts toward it. Continue the reply to carry on.",
  );
  await expect(reply.getByRole("button", { name: "Let Evermind set it" })).toHaveCount(0);
});

test("an older reply cut by the max tokens keeps a short mark, without asking to continue it", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_HITS_CEILING", { reply_cap: { mode: "fixed", tokens: 1024 } });
  await sendFromTheBox(page, convo.id);
  await expect(page.locator("[data-ceiling]")).toHaveCount(1);

  // The next exchange ends as a reply ends: the cut one is no longer the last, and has no Continue.
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });
  await page.waitForLoadState("networkidle");
  await page.locator("textarea").first().fill("And then?");
  const ends = replyEnds(page, convo.id);
  await page.locator('button[title="Send"]').click();
  await ends;

  await expect(page.locator("[data-ceiling]")).toHaveCount(0);
  const cut = page.locator("[data-message-id]").filter({ has: page.locator("[data-ceiling-mark]") });
  await expect(cut).toHaveCount(1);
  await expect(cut.locator("[data-ceiling-mark]")).toHaveText("cut at the limit");
  await expect(cut).not.toContainText("Continue the reply to carry on");
  await expect(page.locator("[data-message-id]").last().locator("[data-ceiling-mark]")).toHaveCount(0);
  await noSidewaysScroll(page);
});

test("the pen's advice on what to change stays until the next try", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await ownAi(request, convo.id);
  // A message the ghost-writer reads, which makes the model reason through all its room.
  await chat(request, { conversation_id: convo.id, mode: "send", content: "MOCK_REASONS_ONLY" });
  await page.goto(`/#/chat/${convo.id}`);

  await page.locator('button[title="Write my reply for me (editable before sending)"]').click();
  const hint = page.locator("[data-input-hint]");
  const advice = "The model spent its whole answer thinking and wrote nothing.";
  await expect(hint).toContainText(advice);
  // Long past the four seconds a passing note stays.
  await page.waitForTimeout(5_000);
  await expect(hint).toContainText(advice);
  await noSidewaysScroll(page);
});

test("the pen's advice is gone once a reply is asked for another way", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await ownAi(request, convo.id);
  // A message the model answers with nothing but thought; the pen reads it too.
  await chat(request, { conversation_id: convo.id, mode: "send", content: "MOCK_REASONS_ONLY" });
  await page.goto(`/#/chat/${convo.id}`);

  await page.locator('button[title="Write my reply for me (editable before sending)"]').click();
  const hint = page.locator("[data-input-hint]");
  const advice = "The model spent its whole answer thinking and wrote nothing.";
  await expect(hint).toContainText(advice);

  // The message is reworded so the model answers; the conversation's own Retry asks again, not the box.
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  const asked = read.messages.at(-1);
  await request.patch(`${API}/api/messages/${asked.id}`, { data: { content: "Tell me more." } });
  const ends = replyEnds(page, convo.id);
  await page.getByRole("button", { name: "Retry" }).click();
  await ends;

  await expect(hint).not.toContainText("wrote nothing");
});
