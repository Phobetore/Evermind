import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { inflateSync } from "node:zlib";
import { API } from "../playwright.config";
import { addModel, chat, conversationWithReply, inLocale, makeConversation, misfits, MOCK, replyEnds, rootAt, stopTurn } from "./fixtures";

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
    "The model spent its whole answer thinking and wrote nothing. Try again: Evermind now knows it thinks first and leaves it room, unless its reply ceiling is set by hand (My AIs, under Advanced). If it happens again, use an AI that does not think as long.",
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
    "Cut short: this reply reached this AI's reply ceiling of 1,024 tokens, and its thinking counts toward it. Continue the reply to carry on.",
  );
  // Said once as the reply comes in, with the reply; not a failure, and not "interrupted".
  await expect(page.getByRole("status")).toContainText("reached this AI's reply ceiling of 1,024 tokens");
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

test("letting Evermind set it lifts the ceiling of the ai that cut the reply, only while it answers", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_HITS_CEILING", { reply_cap: { mode: "fixed", tokens: 300 } });
  const first = (await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).model_id;
  await sendFromTheBox(page, convo.id);
  const reply = page.locator("[data-message-id]").last();
  const lift = reply.getByRole("button", { name: "Let Evermind set it" });
  await expect(reply.locator("[data-ceiling]")).toContainText("reply ceiling of 300 tokens");
  await expect(lift).toBeVisible();

  // Another AI answers now, with a ceiling of its own: the reply was not cut at it.
  const second = await aiOfItsOwn(request, `Roomier ${Date.now()}`, { reply_cap: { mode: "fixed", tokens: 800 } });
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: second.id } });
  await page.reload();
  await expect(reply.locator("[data-ceiling]")).toContainText("reply ceiling of 300 tokens");
  await expect(reply.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  await expect(lift).toHaveCount(0);

  // The AI that cut it answers again: its ceiling can be lifted, and only its own.
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: first } });
  await page.reload();
  await expect(lift).toBeVisible();
  await lift.click();
  await expect(page.locator("[data-chat-toast]")).toContainText("no longer has a ceiling of its own");
  const ais = await (await request.get(`${API}/api/models`)).json();
  const capOf = (id: string) => ais.find((ai: { id: string }) => ai.id === id).reply_cap;
  expect(capOf(first).mode).toBe("auto");
  expect(capOf(second.id)).toEqual({ mode: "fixed", tokens: 800 });
});

test("a reply cut at a ceiling its ai no longer keeps offers nothing to lift", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_HITS_CEILING", { reply_cap: { mode: "fixed", tokens: 300 } });
  const aiId = (await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).model_id;
  await sendFromTheBox(page, convo.id);
  const reply = page.locator("[data-message-id]").last();
  await expect(reply.getByRole("button", { name: "Let Evermind set it" })).toBeVisible();
  // Its ceiling changed since: lifting the new one would not have saved this reply.
  expect((await request.put(`${API}/api/models/${aiId}`, { data: { reply_cap: { mode: "fixed", tokens: 600 } } })).ok()).toBe(true);
  await page.reload();
  await expect(reply.locator("[data-ceiling]")).toContainText("reply ceiling of 300 tokens");
  await expect(reply.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  await expect(reply.getByRole("button", { name: "Let Evermind set it" })).toHaveCount(0);
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

test("a reply cut with no ceiling sent offers nothing to lift once its ai keeps one", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_HITS_CEILING", { reply_cap: { mode: "unsent" } });
  await sendFromTheBox(page, convo.id);
  // The AI then keeps a ceiling of its own: the reply on screen was not cut at it.
  const aiId = (await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).model_id;
  expect((await request.put(`${API}/api/models/${aiId}`, { data: { reply_cap: { mode: "fixed", tokens: 1024 } } })).ok()).toBe(true);
  await page.reload();

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

/** Why a reply was cut, with the button that helps, and what the AI did not read, said where it is
 *  seen. No amount on any of these lines. */

const statusChip = (page: Page) => page.locator("[data-status-row]").getByRole("button", { name: /^Way to play:/ });

/** An AI of its own on the mock, as the page adds it, then given `changes`. */
async function aiOfItsOwn(request: APIRequestContext, name: string, changes: Record<string, unknown>) {
  return addModel(request, {
    base_url: MOCK, name, model: `reply-ends-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, changes,
  });
}

test("a reply cut by its room offers long replies here", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_HITS_CEILING", { reply_cap: { mode: "auto" } });
  await sendFromTheBox(page, convo.id);

  const reply = page.locator("[data-message-id]").last();
  await expect(reply.locator("[data-ceiling]")).toHaveText("Reply cut: it filled the room kept for a medium reply.");
  await expect(reply.getByRole("button", { name: "Let Evermind set it" })).toHaveCount(0);
  await expect(reply.locator("[data-cut-actions]")).not.toContainText("$");
  await noSidewaysScroll(page);

  await reply.getByRole("button", { name: "Long replies here" }).click();
  await expect(page.locator("[data-chat-toast]")).toContainText("Long replies in this conversation.");
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.play_overrides.reply_length).toBe("long");
  await expect(statusChip(page)).toContainText("· adjusted");
  // Asked once: the conversation already asks for long replies.
  await expect(reply.getByRole("button", { name: "Long replies here" })).toHaveCount(0);

  // Continue ends the reply as a reply ends.
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });
  await page.waitForLoadState("networkidle");
  const before = (await reply.locator(".min-w-0 > .mt-1").innerText()).trim();
  const ends = replyEnds(page, convo.id);
  await reply.getByRole("button", { name: "Continue", exact: true }).click();
  await ends;
  await expect(reply.locator("[data-ceiling]")).toHaveCount(0);
  expect((await reply.locator(".min-w-0 > .mt-1").innerText()).trim().length).toBeGreaterThan(before.length);
  const after = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(after.messages.at(-1).meta.cut).toBeUndefined();
});

/** A conversation answered by `aiId`, with `turns` long messages of the person's and their replies:
 *  far more than the 4,090 tokens the mock then says it read. */
async function longStory(request: APIRequestContext, aiId: string, turns: number) {
  const convo = await makeConversation(request);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: aiId } });
  const long = "The rain kept on over the harbour and nobody spoke of the ship. ".repeat(60);
  for (let turn = 0; turn < turns; turn++) {
    await chat(request, { conversation_id: convo.id, mode: "send", content: `${turn}. ${long}` });
  }
  return convo;
}

test("a story read only from its end says so and shrinks", { tag: "@desktop" }, async ({ page, request }) => {
  const name = `Short reader ${Date.now()}`;
  const ai = await aiOfItsOwn(request, name, { context_own: 16384 });
  const convo = await longStory(request, ai.id, 8);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "MOCK_READS_4090" } });
  await sendFromTheBox(page, convo.id);

  const line = page.locator("[data-truncated]");
  await expect(line).toContainText(
    `${name} only read the end of the story. It reads less than expected: ≈ 4,090 tokens, not 16,384.`,
  );
  // Over the input, out of the story that scrolls.
  expect(await line.evaluate((el) => el.closest("[data-story]") === null)).toBe(true);
  await noSidewaysScroll(page);

  // Said of the AI it was counted for: another answering would be given that AI's figure.
  const other = (await (await request.get(`${API}/api/models`)).json()).find((one: { id: string }) => one.id !== ai.id);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: other.id } });
  await page.reload();
  await expect(page.locator("[data-message-id]").last()).toBeVisible();
  await expect(line).toHaveCount(0);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: ai.id } });
  await page.reload();
  await expect(line).toBeVisible();

  const ends = replyEnds(page, convo.id);
  await line.getByRole("button", { name: "Shrink and try again" }).click();
  await ends;
  const ais = await (await request.get(`${API}/api/models`)).json();
  const context = ais.find((one: { id: string }) => one.id === ai.id).context;
  expect([context.read, context.read_kind]).toEqual([4090, "observed"]);
  const after = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(after.messages.at(-1).variants).toHaveLength(2);
  expect(after.messages.at(-1).meta.truncated).toBeUndefined();
  // It goes with the reply that read it.
  await expect(line).toHaveCount(0);
});

test("a story read from its end by a model its ai no longer runs is not said", { tag: "@desktop" }, async ({ page, request }) => {
  const name = `Changed reader ${Date.now()}`;
  const ai = await aiOfItsOwn(request, name, { context_own: 16384 });
  const convo = await longStory(request, ai.id, 8);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "MOCK_READS_4090" } });
  await sendFromTheBox(page, convo.id);
  const line = page.locator("[data-truncated]");
  await expect(line).toBeVisible();

  // Another model under the same AI: what the first read says nothing of what this one reads.
  expect((await request.put(`${API}/api/models/${ai.id}`, { data: { model: `${ai.name}-other-model` } })).ok()).toBe(true);
  const observed: string[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST" && sent.url().endsWith("/observed")) observed.push(sent.url());
  });
  await page.reload();
  await expect(page.locator("[data-message-id]").last()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(line).toHaveCount(0);
  expect(observed).toEqual([]);
});

test("a story read from its end is said under the version that was, not another", { tag: "@desktop" }, async ({ page, request }) => {
  const name = `Swiped reader ${Date.now()}`;
  const ai = await aiOfItsOwn(request, name, { context_own: 16384 });
  // Its last reply read whole.
  const convo = await longStory(request, ai.id, 8);
  await page.goto(`/#/chat/${convo.id}`);
  const reply = page.locator("[data-message-id]").last();
  await expect(reply).toBeVisible();
  const line = page.locator("[data-truncated]");
  await expect(line).toHaveCount(0);

  // Written again, and read only from its end.
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "MOCK_READS_4090" } });
  await page.waitForLoadState("networkidle");
  const ends = replyEnds(page, convo.id);
  await reply.locator('button[title="Regenerate"]').click({ force: true });
  await ends;
  await expect(reply).toContainText("2/2");
  await expect(line).toBeVisible();

  // Back to the version read whole: nothing to say; forward again: said.
  await reply.getByRole("button", { name: "Previous variant" }).click();
  await expect(reply).toContainText("1/2");
  await expect(line).toHaveCount(0);
  await reply.getByRole("button", { name: "Next variant or regenerate" }).click();
  await expect(reply).toContainText("2/2");
  await expect(line).toBeVisible();
});

test("too long is said with its button", { tag: "@desktop" }, async ({ page, request }) => {
  const name = `Narrow ${Date.now()}`;
  const convo = await conversationWithReply(request);
  const ai = await aiOfItsOwn(request, name, {});
  await request.patch(`${API}/api/conversations/${convo.id}`, {
    // Read as 5,000 tokens whatever is sent, and refused past 2,000: refused again once learned.
    data: { model_id: ai.id, author_note: "MOCK_TOO_LONG_2000 MOCK_READS_5000" },
  });
  await sendFromTheBox(page, convo.id);

  const said = page.getByRole("alert");
  await expect(said).toHaveText(`${name} says this is too long for it.`);
  const button = page.getByRole("button", { name: "Shrink and try again" });
  await expect(button).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await noSidewaysScroll(page);

  // Its button asks for the turn again, which the server now answers.
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });
  await page.waitForLoadState("networkidle");
  const ends = replyEnds(page, convo.id);
  await button.click();
  await ends;
  await expect(said).toHaveCount(0);
  const after = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(after.messages.at(-1).role).toBe("assistant");
});

/** The cause stored with the last reply, as the server would have stored it for another AI. */
function withCause(page: Page, id: string, meta: Record<string, unknown>) {
  return page.route(`**/api/conversations/${id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    Object.assign(body.messages.at(-1).meta, meta);
    await route.fulfill({ response, json: body });
  });
}

/** What the server stores of the conversation's last reply, first version, when the AI that answers
 *  it read only the end of the story: the version, the AI and the model it was read by. */
async function readFromItsEnd(request: APIRequestContext, id: string) {
  const named = (await (await request.get(`${API}/api/conversations/${id}`)).json()).model_id;
  const ais = await (await request.get(`${API}/api/models`)).json();
  const ai = ais.find((one: { id: string; is_default: boolean }) => (named ? one.id === named : one.is_default));
  return {
    truncated: { read: 4090, window: 131072, version: 0, model_id: ai.id, model: ai.model },
    usage: { prompt: 4090, completion: 40, model_id: ai.id, model: ai.model },
  };
}

test("neither line stays while the reply is written again", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await withCause(page, convo.id, {
    ceiling: { "0": null }, cut: { "0": { mode: "auto", length: "medium", thought: false } },
    ...await readFromItsEnd(request, convo.id),
  });
  await page.goto(`/#/chat/${convo.id}`);
  const reply = page.locator("[data-message-id]").last();
  await expect(reply.locator("[data-cut-actions]")).toBeVisible();
  await expect(page.locator("[data-truncated]")).toBeVisible();

  // Until the server says which reply is being written, the old version stays on screen: held
  // there, its line must already be without its buttons.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/conversations/${convo.id}/turn`, async (route) => {
    if (route.request().method() === "GET") await held;
    await route.fallback();
  });
  await reply.locator('button[title="Regenerate"]').click({ force: true });
  try {
    // What they say is of the version being replaced, and their buttons would ask for a second turn.
    await expect(reply.locator("[data-ceiling]")).toBeVisible();
    await expect(reply.locator("[data-cut-actions]")).toHaveCount(0);
    await expect(page.locator("[data-truncated]")).toHaveCount(0);
    release();
    await expect(page.locator('button[title="Stop generation"]')).toBeVisible();
    await expect(page.locator("[data-truncated]")).toHaveCount(0);
    await expect(page.locator("[data-cut-actions]")).toHaveCount(0);
  } finally {
    release();
    // A read still on its way when the test ends is no failure of the page.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await stopTurn(request, convo.id);
  }
});

const SHRINK: Record<string, string> = { en: "Shrink and try again", de: "Verkleinern und erneut versuchen" };

/** How light a screenshot is, its channels averaged: the PNG's own rows, unfiltered. */
function lightness(png: Buffer): number {
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const data: Buffer[] = [];
  while (at < png.length) {
    const size = png.readUInt32BE(at);
    const kind = png.toString("latin1", at + 4, at + 8);
    if (kind === "IHDR") {
      width = png.readUInt32BE(at + 8);
      height = png.readUInt32BE(at + 12);
      channels = png[at + 17] === 2 ? 3 : 4;
    }
    if (kind === "IDAT") data.push(png.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  let sum = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      line[x] = (line[x] + [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
      if (x % channels < 3) sum += line[x];
    }
    previous = line;
  }
  return sum / (width * height * 3);
}

/** Whether the shade at the foot of the line's sentence is drawn: a strip of its side padding, where
 *  no text is, against one of the button's row under it, which is the page's colour. The page has a
 *  grain of a few levels; the shade lifts the strip by some twenty. */
async function shadeAtFoot(page: Page): Promise<boolean> {
  const part = (await page.locator("[data-truncated-text]").boundingBox())!;
  const row = (await page.locator("[data-truncated] > div").boundingBox())!;
  const foot = await page.screenshot({ clip: { x: part.x + 4, y: part.y + part.height - 6, width: 8, height: 4 } });
  const plain = await page.screenshot({ clip: { x: row.x + 4, y: row.y + 1, width: 8, height: 4 } });
  return lightness(foot) - lightness(plain) > 6;
}

test("the keyboard's sentence stays beside the line over the input where there is room", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await withCause(page, convo.id, await readFromItsEnd(request, convo.id));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/chat/${convo.id}`);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("16px");
  await expect(page.locator("[data-truncated]")).toBeVisible();
  const hint = page.locator("[data-status-row]").getByText("Enter to send · Shift+Enter for a new line · quill: the AI drafts your reply");
  // A keyboard's: a touch screen has none, line or not.
  if (test.info().project.name === "desktop") await expect(hint).toBeVisible();
  else await expect(hint).toHaveCount(0);
  // The whole sentence shows: no shade says there is more.
  expect(await page.locator("[data-truncated-text]").evaluate((part) => part.scrollHeight <= part.clientHeight)).toBe(true);
  expect(await shadeAtFoot(page), "a shade under a whole sentence").toBe(false);
});

// German has the longest of these lines. Also in a window with a keyboard, whose sentence under the
// input takes room a phone does not give it.
for (const locale of ["en", "de"]) {
  test(`the lines of a cut reply and of a story read from its end fit a phone, whatever the size of its text, in ${locale}`, { tag: "@desktop" }, async ({ page, request }) => {
    const convo = await endingWith(request, "MOCK_HITS_CEILING", { reply_cap: { mode: "fixed", tokens: 1024 } });
    await chat(request, { conversation_id: convo.id, mode: "send", content: "What now?" });
    const ceiling = { "0": 1024 };
    const cases = {
      fixed: { ceiling, cut: { "0": { mode: "fixed", length: "medium", thought: false } } },
      thought: { ceiling, cut: { "0": { mode: "auto", length: "medium", thought: true } } },
      room: {
        ceiling, cut: { "0": { mode: "auto", length: "short", thought: false } },
        // Beside it, the line over the input.
        ...await readFromItsEnd(request, convo.id),
      },
    };
    await inLocale(page, locale);
    await page.addInitScript(rootAt, "32px");
    for (const [cause, meta] of Object.entries(cases)) {
      await page.unrouteAll();
      await withCause(page, convo.id, meta);
      for (const size of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
        await page.setViewportSize(size);
        await page.goto("about:blank");
        await page.goto(`/#/chat/${convo.id}`);
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");
        const reply = page.locator("[data-message-id]").last();
        await expect(reply.locator("[data-cut-actions] button").first()).toBeVisible();
        if (cause === "room") {
          await expect(page.locator("[data-truncated]")).toBeVisible();
          // The line over the input never takes the whole screen: the story keeps a line of its text
          // seen over the room left under the last message.
          const room = await page.locator("[data-story]").evaluate((story) => story.clientHeight);
          const under = await page.locator("[data-story] > div").evaluate((inner) => parseFloat(getComputedStyle(inner).paddingBottom));
          const line = await reply.locator(".min-w-0 > .mt-1").evaluate((text) => parseFloat(getComputedStyle(text).lineHeight));
          expect(room, `the story's room at ${size.width}`).toBeGreaterThanOrEqual(line + under);
          // Its sentence may scroll in its own part, but its button is whole and seen without
          // scrolling anything: a phone shows no scrollbar to say it is there.
          const shrink = page.locator("[data-truncated]").getByRole("button", { name: SHRINK[locale] });
          const seen = await shrink.evaluate((button) => {
            const box = button.getBoundingClientRect();
            const input = document.querySelector("textarea")!.closest(".border-t")!.getBoundingClientRect();
            const sentence = button.closest("[data-truncated]")!.querySelector("[data-truncated-text]")!.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return {
              between: box.top >= sentence.bottom - 0.5 && box.bottom <= input.top + 0.5,
              reached: hit !== null && button.contains(hit),
            };
          });
          expect(seen, `the button at ${size.width}`).toEqual({ between: true, reached: true });
          // Where the sentence scrolls, a shade at its foot says there is more, and goes at its end.
          const part = page.locator("[data-truncated-text]");
          const scrolls = await part.evaluate((text) => text.scrollHeight > text.clientHeight + 1);
          if (size.width === 320) expect(scrolls, "the sentence scrolls at 320").toBe(true);
          expect(await shadeAtFoot(page), `the shade at ${size.width}`).toBe(scrolls);
          if (scrolls) {
            await part.evaluate((text) => { text.scrollTop = text.scrollHeight; });
            expect(await shadeAtFoot(page), `the shade at the sentence's end at ${size.width}`).toBe(false);
            await part.evaluate((text) => { text.scrollTop = 0; });
          }
        }
        await reply.locator("[data-ceiling]").scrollIntoViewIfNeeded();
        expect(await misfits(page), `${cause} at ${size.width}`).toEqual([]);
      }
    }
  });
}
