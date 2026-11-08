import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { API } from "../playwright.config";
import { chat, conversation, conversationWithReply } from "./fixtures";

/**
 * A phone on a home Wi-Fi, where what was asked for reaches Evermind and its answer is lost on the
 * way back, or comes late: the page ends with what the server holds, and makes nothing twice.
 */

/** What Evermind does with the request, before its answer is lost on the way back. */
const answerLost = async (route: Route) => {
  await route.fetch();
  await route.abort("connectionreset");
};

/** The next request like this one waits until let go, as on a Wi-Fi that is slow to come back. */
async function held(page: Page, url: string, method: string) {
  let letGo = () => {};
  const waiting = new Promise<void>((resolve) => (letGo = resolve));
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    await waiting;
    await route.fallback();
  }, { times: 1 });
  return letGo;
}

/** A reply in three versions told apart, the last of them shown: [another, alpha, beta]. */
async function threeVersions(request: APIRequestContext) {
  const convo = await conversationWithReply(request, { says: "alpha" });
  await chat(request, { conversation_id: convo.id, mode: "regenerate" });
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "MOCK_SAYS_beta" } });
  await chat(request, { conversation_id: convo.id, mode: "regenerate" });
  const read = await conversation(request, convo.id);
  expect(read.messages.at(-1).variants.map((v: string) => v.split(" ")[0]).slice(1)).toEqual(["alpha", "beta"]);
  return read;
}

const versionsOf = async (request: APIRequestContext, id: string): Promise<string[]> =>
  (await conversation(request, id)).messages.at(-1).variants;

test("a swipe whose answer was lost shows the version the server holds, and an edit then goes into it", async ({ page, request }) => {
  const convo = await threeVersions(request);
  const reply = page.locator(`[data-message-id="${convo.messages.at(-1).id}"]`);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(reply).toContainText("3/3");

  await page.route("**/api/messages/*", answerLost, { times: 1 });
  await reply.getByLabel("Previous variant").click();

  await expect(reply).toContainText("2/3");
  await expect(reply).toContainText("alpha one two");
  await expect(page.getByRole("alert"), "said to have failed when it worked").toHaveCount(0);
  await reply.getByTitle("Edit").click();
  const editor = reply.locator("textarea");
  await editor.fill((await editor.inputValue()).replace("one two", "one, two"));
  await reply.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);

  const [, alpha, beta] = await versionsOf(request, convo.id);
  expect(alpha).toContain("alpha one, two");
  expect(beta, "the version swiped from was written over").toContain("beta one two");
});

test("an edit opened while a swipe is on its way is saved into the version it was opened on", async ({ page, request }) => {
  const convo = await threeVersions(request);
  const reply = page.locator(`[data-message-id="${convo.messages.at(-1).id}"]`);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(reply).toContainText("3/3");

  const letGo = await held(page, "**/api/messages/*", "PATCH");
  await reply.getByLabel("Previous variant").click();
  await reply.getByTitle("Edit").click();
  const editor = reply.locator("textarea");
  await expect(editor).toHaveValue(/^beta one two/);
  const swiped = page.waitForResponse((r) => r.request().method() === "PATCH");
  letGo();
  expect((await swiped).ok()).toBe(true);
  await editor.fill((await editor.inputValue()).replace("one two", "one, two"));
  await reply.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);

  const [, alpha, beta] = await versionsOf(request, convo.id);
  expect(alpha, "the version swiped to was written over").toContain("alpha one two");
  expect(beta).toContain("beta one, two");
  await expect(reply).toContainText("beta one, two");
  await expect(reply).toContainText("3/3");
});

test("Delete from here whose answer was lost shows the story the server holds, and says nothing", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const [asked, answered] = convo.messages.slice(-2);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator(`[data-message-id="${answered.id}"]`)).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());

  await page.route("**/api/messages/*", answerLost, { times: 1 });
  await page.locator(`[data-message-id="${asked.id}"]`).getByTitle("Delete from here").click();

  await expect(page.locator(`[data-message-id="${asked.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-message-id="${answered.id}"]`)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await conversation(request, convo.id)).messages).toHaveLength(convo.messages.length - 2);
});

test("Delete from here on a message already gone shows the story as it is, and says nothing", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const answered = convo.messages.at(-1);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator(`[data-message-id="${answered.id}"]`)).toBeVisible();
  // Gone already: deleted from another device, or by a first tap whose answer was lost.
  await request.delete(`${API}/api/messages/${answered.id}`);
  page.on("dialog", (dialog) => dialog.accept());

  await page.locator(`[data-message-id="${answered.id}"]`).getByTitle("Delete from here").click();

  await expect(page.locator(`[data-message-id="${answered.id}"]`)).toHaveCount(0);
  await expect(page.getByRole("alert"), "a message on screen said to be gone").toHaveCount(0);
});
