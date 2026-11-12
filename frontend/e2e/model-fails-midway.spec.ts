import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { chat, conversationWithReply, replyEnds } from "./fixtures";

/**
 * A model whose connection breaks after four words (see scripts/mock_llm.py). What had
 * arrived is the reply as far as it goes: it stays, through the failure and through a
 * reload, and says it was cut short.
 *
 * The sentence about the failure belongs to the page that asked for the reply. A page
 * that opens afterwards finds the reply and its label and no sentence, so the label is
 * what says it, and says it without a time limit.
 */

const WORDS = "alpha one two three";
const WHOLE = "endalpha";

const reply = (page: Page) => page.locator("[data-message-id]", { hasText: WORDS });
const failure = (page: Page) =>
  page.getByText("The model took too long to answer, or the connection to its server broke.");

/** The conversation, with the model told to break, and a message sent from the box. */
async function failedMidway(page: Page, request: APIRequestContext) {
  const convo = await conversationWithReply(request, { says: "alpha", failsMidway: true });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Go on.");
  // The failure is said once the page hears the reply has ended.
  const over = replyEnds(page, convo.id);
  await page.locator('button[title="Send"]').click();
  await over;
  await expect(failure(page)).toBeVisible();
  return convo;
}

/** The model works again. */
const mendModel = (request: APIRequestContext, id: string) =>
  request.patch(`${API}/api/conversations/${id}`, { data: { author_note: "MOCK_SAYS_alpha" } });

test("the words that arrived stay, and the reply says it was cut short", async ({ page, request }) => {
  await failedMidway(page, request);

  await expect(reply(page)).toBeVisible();
  await expect(reply(page)).not.toContainText("four");
  await expect(reply(page)).toContainText("interrupted");
});

test("after a reload the words and the label are there, and the label is what says it", async ({
  page, request,
}) => {
  const convo = await failedMidway(page, request);

  await page.reload();

  await expect(reply(page)).toBeVisible();
  await expect(reply(page)).toContainText("interrupted");
  // The sentence about the failure is for the page that asked for the reply.
  await expect(failure(page)).toHaveCount(0);
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.messages.at(-1).meta).toEqual({ interrupted: [0] });
});

test("Retry adds a whole reply, without the label that stays on the one cut short", async ({ page, request }) => {
  const convo = await failedMidway(page, request);
  await mendModel(request, convo.id);

  const over = replyEnds(page, convo.id);
  await page.getByRole("button", { name: "Retry" }).click();
  // The whole reply shows as it arrives, before it is saved: what the server holds is read at its end.
  await over;

  const message = page.locator("[data-message-id]", { hasText: WHOLE });
  await expect(message).toBeVisible();
  await expect(message).not.toContainText("interrupted");
  await expect(failure(page)).toHaveCount(0);
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  const last = read.messages.at(-1);
  expect(last.variants).toHaveLength(2);
  expect(last.variants[0]).toBe(WORDS);
  expect(last.variants[1]).toContain(WHOLE);
  expect(last.meta.interrupted).toEqual([0]);

  await page.getByRole("button", { name: "Previous variant" }).click();
  await expect(reply(page)).toContainText("interrupted");
  await page.getByRole("button", { name: "Next variant or regenerate" }).click();
  await expect(message).toBeVisible();
  await expect(message).not.toContainText("interrupted");
});

test("a regeneration cut short labels its own version, not the whole one", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { says: "alpha" });
  await chat(request, { conversation_id: convo.id, mode: "send", content: "Go on." });
  await request.patch(`${API}/api/conversations/${convo.id}`, {
    data: { author_note: "MOCK_SAYS_alpha MOCK_FAILS_MIDWAY" },
  });
  await page.goto(`/#/chat/${convo.id}`);
  const last = page.locator("[data-message-id]").last();
  await expect(last).toContainText(WHOLE);

  await last.getByRole("button", { name: "Regenerate" }).click();
  await expect(failure(page)).toBeVisible();
  await expect(last).toContainText("interrupted");

  await last.getByRole("button", { name: "Previous variant" }).click();

  await expect(last).toContainText(WHOLE);
  await expect(last).not.toContainText("interrupted");
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.messages.at(-1).meta.interrupted).toEqual([1]);
});
