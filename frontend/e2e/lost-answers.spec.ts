import { expect, test, type APIRequestContext, type Locator, type Page, type Request, type Route } from "@playwright/test";
import { API } from "../playwright.config";
import { answer, chat, conversation, conversationWithReply, makeCharacter, readOf } from "./fixtures";

/** An answer lost or late on a phone's Wi-Fi: the page ends with what the server holds, and makes nothing twice. */

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

/** Settles once the page's read of the conversation, sent after the answer to a `method` on a
 *  message was lost or refused, has come back: what the server holds shows from there, and how long
 *  the server takes over both is the machine's. Called before what sends the change. */
function storyReadAfter(page: Page, id: string, method: string): Promise<unknown> {
  let over = false;
  const ended = (r: Request) => {
    if (r.method() === method && new URL(r.url()).pathname.includes("/api/messages/")) over = true;
  };
  page.on("requestfailed", ended);
  page.on("requestfinished", ended);
  return page.waitForResponse((r) => over && r.request().method() === "GET" && readOf(id)(r.url()))
    .finally(() => {
      page.off("requestfailed", ended);
      page.off("requestfinished", ended);
    });
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
  const readAfter = storyReadAfter(page, convo.id, "PATCH");
  await reply.getByLabel("Previous variant").click();
  await readAfter;

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

  await page.route("**/api/messages/*", answerLost, { times: 1 });
  // What the server holds shows once the read that follows the lost answer has come back.
  const readAfter = storyReadAfter(page, convo.id, "DELETE");
  await page.locator(`[data-message-id="${asked.id}"]`).getByTitle("Delete from here").click();
  await answer(page, true);
  await readAfter;

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

  const readAfter = storyReadAfter(page, convo.id, "DELETE");
  await page.locator(`[data-message-id="${answered.id}"]`).getByTitle("Delete from here").click();
  await answer(page, true);
  await readAfter;

  await expect(page.locator(`[data-message-id="${answered.id}"]`)).toHaveCount(0);
  await expect(page.getByRole("alert"), "a message on screen said to be gone").toHaveCount(0);
});

const branchesOf = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`${API}/api/conversations`)).json()) as { forked_from: string | null }[])
    .filter((c) => c.forked_from === id).length;

test("Branch shows that it is under way, and a second tap makes no second branch", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const reply = page.locator(`[data-message-id="${convo.messages.at(-1).id}"]`);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(reply).toBeVisible();

  const letGo = await held(page, "**/api/messages/*/branch", "POST");
  const branch = reply.getByTitle("Branch the story from here");
  await branch.click();
  await answer(page, true);
  await expect(branch, "nothing shows the branch is being made").toBeDisabled();
  await branch.click({ force: true });
  letGo();

  await expect(page).not.toHaveURL(new RegExp(convo.id));
  await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length);
  expect(await branchesOf(request, convo.id)).toBe(1);
});

test("Branch whose answer was lost, tried again, makes one branch", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const reply = page.locator(`[data-message-id="${convo.messages.at(-1).id}"]`);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(reply).toBeVisible();

  await page.route("**/api/messages/*/branch", answerLost, { times: 1 });
  await reply.getByTitle("Branch the story from here").click();
  await answer(page, true);
  await expect(page.getByRole("alert")).toContainText("Evermind is not answering");
  await reply.getByTitle("Branch the story from here").click();
  await answer(page, true);

  await expect(page).not.toHaveURL(new RegExp(convo.id));
  expect(await branchesOf(request, convo.id)).toBe(1);
});

test("Enter the story whose answer was lost, tried again, makes one conversation", async ({ page, request }) => {
  const character = await makeCharacter(request);
  await page.goto(`/#/characters/${character.id}`);
  await page.getByRole("button", { name: "Start a conversation" }).click();
  const dialog = page.getByRole("dialog");
  const enter = dialog.getByRole("button", { name: "Enter the story" });
  await expect(enter).toBeEnabled();

  await page.route("**/api/conversations", (route) =>
    route.request().method() === "POST" ? answerLost(route) : route.fallback(), { times: 1 });
  await enter.click();
  await expect(dialog).toContainText("Evermind is not answering");
  await enter.click();

  await expect(page).toHaveURL(/#\/chat\//);
  const made = await (await request.get(`${API}/api/conversations?character_id=${character.id}`)).json();
  expect(made).toHaveLength(1);
});

const SUMMARY = "Updated automatically by memory; freely editable. Injected into every turn.";

/** A conversation open with its side panel showing, and a summary from before any pass. */
async function withThePanel(page: Page, request: APIRequestContext) {
  const convo = await conversationWithReply(request);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { summary: "Old summary from last week." } });
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel.getByPlaceholder(SUMMARY)).toHaveValue("Old summary from last week.");
  return { convo, panel };
}

/** The panel shows what the server holds once the pass is done, and says nothing in red. */
async function expectWhatThePassWrote(panel: Locator, request: APIRequestContext, id: string) {
  const facts = await (await request.get(`${API}/api/conversations/${id}/memories`)).json();
  const { summary } = await conversation(request, id);
  expect(summary, "no pass was made").not.toBe("Old summary from last week.");
  await expect(panel.getByPlaceholder(SUMMARY)).toHaveValue(summary);
  await expect(panel).toContainText(`(${facts.length})`);
  await expect(panel.locator(".text-blood"), "a pass that worked said to have failed").toHaveCount(0);
}

test("Remember whose answer was lost ends with what the pass wrote, and says nothing once Evermind answers", async ({ page, request }) => {
  const { convo, panel } = await withThePanel(page, request);
  let lost = () => {};
  const passDone = new Promise<void>((resolve) => (lost = resolve));

  await page.route("**/memories/extract", async (route) => {
    await answerLost(route);
    lost();
  }, { times: 1 });
  await panel.getByRole("button", { name: "Remember" }).click();
  await passDone;

  await expectWhatThePassWrote(panel, request, convo.id);
});

test("Remember on a phone that went offline ends, once it is back, with what the pass wrote", async ({ page, request }) => {
  const { convo, panel } = await withThePanel(page, request);

  await page.route("**/memories/extract", async (route) => {
    await route.fetch();
    await page.context().setOffline(true);
    await route.abort("internetdisconnected");
  }, { times: 1 });
  await panel.getByRole("button", { name: "Remember" }).click();
  await expect(panel).toContainText("This device is offline.");
  await page.context().setOffline(false);

  await expectWhatThePassWrote(panel, request, convo.id);
});

test("Remember that met a pass under way ends, once that pass is done, with what it wrote, and reads no story meanwhile", async ({ page, request }) => {
  const { convo, panel } = await withThePanel(page, request);
  // The server says a pass is running for as long as the one below is not done.
  let running = true;
  let stories = 0;
  await page.route(readOf(convo.id), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const read = await response.json();
    if (read.messages) stories += 1;
    await route.fulfill({ response, json: { ...read, memory_running: running } });
  });

  await page.route("**/memories/extract", (route) => route.fulfill({
    status: 409, json: { error: "Another memory task is running.", kind: "memory_busy" },
  }), { times: 1 });
  await panel.getByRole("button", { name: "Remember" }).click();
  await expect(panel).toContainText("Another memory task is running.");
  expect((await request.post(`${API}/api/conversations/${convo.id}/memories/extract`)).ok()).toBe(true);
  running = false;

  await expectWhatThePassWrote(panel, request, convo.id);
  expect(stories, "the whole story downloaded to learn whether a pass runs").toBe(0);
});
