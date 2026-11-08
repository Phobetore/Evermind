import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { chat, conversation, conversationWithReply } from "./fixtures";

/**
 * A phone on a home Wi-Fi, where what was asked for reaches Evermind and its answer is lost on the
 * way back, or comes late: the page ends with what the server holds, and makes nothing twice.
 */

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
