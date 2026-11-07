import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { conversationWithReply } from "./fixtures";

/**
 * A model whose connection breaks after four words. What had arrived is the reply as
 * far as it goes: it stays, through the failure and through a reload, and says it was
 * cut short. The mock sends a length it does not keep (scripts/mock_llm.py), which is
 * what makes the client see the connection break rather than the reply end.
 *
 * The sentence about the failure belongs to the page that watched it. A page that
 * opens afterwards finds the reply and its label and no sentence, so the label is what
 * says it, and says it without a time limit.
 */

const WORDS = "alpha one two three";
const WHOLE = "endalpha";

const reply = (page: Page) => page.locator("[data-message-id]", { hasText: WORDS });
const failure = (page: Page) => page.getByText("The connection to the model's server failed.");

/** The conversation, with the model told to break, and a message sent from the box. */
async function failedMidway(page: Page, request: APIRequestContext) {
  const convo = await conversationWithReply(request, { says: "alpha", failsMidway: true });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Go on.");
  await page.locator('button[title="Send"]').click();
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
  // The server still has the turn for a while, and the page that opens does not read its
  // ending: the sentence about the failure is for the page that watched it.
  await expect(failure(page)).toHaveCount(0);
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.messages.at(-1).meta).toEqual({ interrupted: [0] });
});

test("Retry adds a whole reply, without the label that stays on the one cut short", async ({ page, request }) => {
  const convo = await failedMidway(page, request);
  await mendModel(request, convo.id);

  await page.getByRole("button", { name: "Retry" }).click();

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
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "Go on.", message_mode: "say" },
    timeout: 60_000,
  });
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
