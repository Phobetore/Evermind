import { expect, test, type APIRequestContext, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API } from "../playwright.config";
import { answer, chat, makeConversation, readOf, remembered, replyEnds, turnRunning } from "./fixtures";

/**
 * Taking the story back from a message takes what was remembered of it back too: the facts
 * drawn from the turns that went, and the summary, to the one of the turns that stay.
 */

const en = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "src", "i18n", "locales", "en.json"), "utf8"),
);
const panelText = en.chat.panel as {
  closeAriaLabel: string;
  directive: { placeholder: string; applyButton: string };
  summary: { placeholder: string; saveButton: string };
  facts: {
    extractButton: string; consolidateButton: string; pinTitle: string; unpinTitle: string;
    forgetAriaLabel: string; addPlaceholder: string;
  };
};

test("cutting the story back empties the summary and the facts of what went", async ({ page, request }) => {
  const convo = await makeConversation(request);
  for (const content of ["First question.", "Second question."]) {
    expect((await chat(request, { conversation_id: convo.id, mode: "send", content })).ok()).toBe(true);
  }
  // The model's memory pass writes two facts and a summary; one fact is by hand.
  const pass = await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, {
    timeout: 60_000,
  });
  expect(pass.ok()).toBe(true);
  await request.post(`${API}/api/conversations/${convo.id}/memories`, {
    data: { content: "Written by hand.", is_pinned: true },
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  // On a laptop the panel is beside the conversation; on a phone it covers it.
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  const covers = await opener.isVisible();
  if (covers) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(panel).toContainText("(3)");
  await expect(summary).toHaveValue(/woke the character in a crypt/);

  // The greeting, the first question and its reply stay; the second question goes.
  if (covers) await panel.getByLabel(panelText.closeAriaLabel).click();
  await page.getByTitle("Delete from here").nth(3).click();
  await answer(page, true);
  if (covers) await opener.click();

  await expect(panel).toContainText("(1)");
  await expect(summary).toHaveValue("");
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.messages).toHaveLength(3);
  expect(read.summary).toBe("");
  // The pass was the first, so there is no earlier summary to go back to.
  expect(read.memory_position).toBe(0);
});

test("cutting the story back puts the summary it had back", async ({ page, request }) => {
  const convo = await makeConversation(request);
  const say = (content: string) => chat(request, { conversation_id: convo.id, mode: "send", content });
  const pass = () =>
    request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await say("First question.");
  await pass();
  const first = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  await say("Second question.");
  await pass();
  const before = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  // The mock's summary names the newest turn it read.
  expect(first.summary).toMatch(/woke the character in a crypt/);
  expect(before.summary).not.toBe(first.summary);
  expect(before.memory_position).toBe(4);

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  const covers = await opener.isVisible();
  if (covers) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue(before.summary);

  // Reopened on a phone, the panel's own read never lands: the cut must be on the page already.
  let reopened = false;
  await page.route(readOf(convo.id), async (route) => {
    if (!reopened || route.request().method() !== "GET") await route.continue();
  });
  // greeting, then two questions and their replies: the second question is the fourth message.
  if (covers) await panel.getByLabel(panelText.closeAriaLabel).click();
  // Read again after the cut by the panel beside the story, or by the page while the panel is closed.
  const cut = page.waitForResponse((r) => r.request().method() === "GET"
    && readOf(convo.id)(r.url()));
  await page.getByTitle("Delete from here").nth(3).click();
  await answer(page, true);
  await cut;
  if (covers) {
    reopened = true;
    await opener.click();
  }

  // The second pass had read to the second reply; the first, to the first.
  await expect(summary).toHaveValue(first.summary);
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.summary).toBe(first.summary);
  expect(read.memory_position).toBe(2);
});

// Typing over the summary it put back would send one no pass holds, and take the memory back to 0.
test("the page's read of a cut, landing once a summary is saved in the panel, does not put the old one back", async ({ page, request }) => {
  const convo = await makeConversation(request);
  const say = (content: string) => chat(request, { conversation_id: convo.id, mode: "send", content });
  const pass = () =>
    request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await say("First question.");
  await pass();
  const first = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  await say("Second question.");
  await pass();

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  // Closed, as on a phone, for the page to read the summary after the cut.
  if (!(await opener.isVisible())) await panel.getByLabel(panelText.closeAriaLabel).click();
  await page.waitForLoadState("networkidle");

  // That read is answered, and its answer held until the summary is saved.
  let fetched = () => {};
  const answered = new Promise<void>((resolve) => { fetched = resolve; });
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  await page.route(readOf(convo.id), async (route) => {
    if (route.request().method() !== "GET" || ++reads > 1) return route.continue();
    const old = await route.fetch();
    fetched();
    await released;
    await route.fulfill({ response: old }).catch(() => {});
  });
  await page.getByTitle("Delete from here").nth(3).click();
  await answer(page, true);
  await answered;

  await opener.click();
  await expect(summary).toHaveValue(first.summary);
  await summary.fill("Typed once the story was cut.");
  await panel.getByRole("button", { name: panelText.summary.saveButton }).click();
  await expect(panel.getByRole("button", { name: panelText.summary.saveButton })).toBeHidden();

  release();
  await page.waitForTimeout(500);
  await expect(summary).toHaveValue("Typed once the story was cut.");
});

// A slow model can take minutes: what is typed meanwhile is typed over the summary from before.
test("the summary box can be typed in while the memory reads the story", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "First question.", message_mode: "say" },
    timeout: 60_000,
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/memories/extract", async (route) => {
    await released;
    await route.continue();
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  const asked = page.waitForRequest((r) => r.url().endsWith("/memories/extract"));
  await panel.getByRole("button", { name: panelText.facts.extractButton, exact: true }).click();
  await asked;

  await expect(summary).toBeEnabled();
  await summary.fill("Typed while it reads.");
  const passed = remembered(page);
  release();
  await passed;
  await expect(panel).toContainText("(2)");

  await expect(summary).toHaveValue("Typed while it reads.");
  await panel.getByRole("button", { name: panelText.summary.saveButton }).click();
  await expect(panel.getByRole("button", { name: panelText.summary.saveButton })).toBeHidden();
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.summary).toBe("Typed while it reads.");
  // Typed over the summary from before Remember: the turns it read are read again.
  expect(read.memory_position).toBe(0);
});

test("a summary being typed is not replaced by one a pass wrote meanwhile", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await chat(request, { conversation_id: convo.id, mode: "send", content: "First question." });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await summary.fill("Typed, not saved yet.");

  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);

  await expect(summary).toHaveValue("Typed, not saved yet.");
  await panel.getByRole("button", { name: panelText.summary.saveButton }).click();
  await expect(panel.getByRole("button", { name: panelText.summary.saveButton })).toBeHidden();
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.summary).toBe("Typed, not saved yet.");
  // Typed over the summary from before the pass: the turns the pass read are read again.
  expect(read.memory_position).toBe(0);
});

test("a summary being typed stays through a Remember", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "First question.", message_mode: "say" },
    timeout: 60_000,
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await summary.fill("Typed, not saved yet.");

  const passed = remembered(page);
  await panel.getByRole("button", { name: panelText.facts.extractButton, exact: true }).click();
  await passed;
  await expect(panel).toContainText("(2)");

  await expect(summary).toHaveValue("Typed, not saved yet.");
  // Typed on once Remember's summary is in: still typed over the one from before it.
  await summary.press("End");
  await summary.pressSequentially(" More.");
  await panel.getByRole("button", { name: panelText.summary.saveButton }).click();
  await expect(panel.getByRole("button", { name: panelText.summary.saveButton })).toBeHidden();
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.summary).toBe("Typed, not saved yet. More.");
  expect(read.memory_position).toBe(0);
});

test("a summary a pass wrote meanwhile shows when the person comes back to the window", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await chat(request, { conversation_id: convo.id, mode: "send", content: "First question." });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue("");

  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(summary).toHaveValue(/woke the character in a crypt/);
});

// On a laptop nothing else reads what a pass wrote before the person edits the summary.
test("the summary box shows what a pass wrote when it is entered", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await makeConversation(request);
  await chat(request, { conversation_id: convo.id, mode: "send", content: "First question." });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue("");
  // The reads of the opening are done before the pass writes.
  await page.waitForLoadState("networkidle");

  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await summary.click();

  await expect(summary).toHaveValue(/woke the character in a crypt/);
});

// On a wide screen the panel stays beside the story while its newest reply is written over. One
// test for each way of writing it over: each is a pass of the memory and a reply, which a loaded
// machine makes long.
const writtenOver = {
  regenerated: { title: en.chat.message.regenerateTitle },
  "carried on": { title: en.chat.message.continueTitle },
  "swiped back": { label: en.chat.message.prevVariantAriaLabel },
} as const;
for (const [how, button] of Object.entries(writtenOver)) {
  test(`the panel beside the story reads the memory again once a reply ${how} takes it back`, { tag: "@desktop" }, async ({ page, request, isMobile }) => {
    test.skip(isMobile, "a phone's panel is closed to reach the reply, and reads on opening");
    const swiped = how === "swiped back";
    const { convo, first, panel, summary, reply } = await readToTheNewestReply(page, request, { twice: swiped });
    // What the panel reads the memory again on: a reply's end, or the swipe's answer.
    const heard = swiped
      ? page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname.includes("/api/messages/"))
      : replyEnds(page, convo.id);
    await reply.hover();
    await ("title" in button ? reply.getByTitle(button.title) : reply.getByLabel(button.label)).click();
    await heard;
    await expect(summary, `the summary once the reply is ${how}`).toHaveValue(first.summary);

    // Typed over the summary the memory holds, which keeps its place.
    await summary.fill(`${first.summary} Typed.`);
    await panel.getByRole("button", { name: panelText.summary.saveButton }).click();
    await expect(panel.getByRole("button", { name: panelText.summary.saveButton })).toBeHidden();
    const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
    expect(read.memory_position).toBe(2);
  });
}

/** A story open on a wide screen, the panel beside it showing a summary that read the newest reply:
 *  asking for that reply again takes the memory back to `first`, the story as the pass before left it.
 *  `twice`: that reply was asked for again once already, so that there is a version to swipe back to. */
async function readToTheNewestReply(page: Page, request: APIRequestContext, { twice = false } = {}) {
  const convo = await makeConversation(request);
  const say = (content: string) => chat(request, { conversation_id: convo.id, mode: "send", content });
  await say("First question.");
  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  const first = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  await say("Second question.");
  if (twice) await chat(request, { conversation_id: convo.id, mode: "regenerate" });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue(first.summary);
  // Read to the newest reply, which asking for again takes back to the first pass.
  const passed = remembered(page);
  await panel.getByRole("button", { name: panelText.facts.extractButton, exact: true }).click();
  await passed;
  await expect(summary).not.toHaveValue(first.summary);
  const { revision } = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  return { convo, first, panel, summary, revision: revision as number, reply: page.locator("[data-message-id]").last() };
}

/** The server takes the next request for a turn; its answer hangs until let go, and is lost then. */
async function answerHangs(page: Page) {
  let letGo = () => {};
  const hanging = new Promise<void>((resolve) => (letGo = resolve));
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await hanging;
    await route.abort("connectionreset");
  });
  return letGo;
}

/** Settles once the page has read from the server that nothing is being written and the story is no
 *  longer the one of revision `before`: the turn asked for has ended, whichever way the page learned
 *  it. Called before the click, so that a word the page has at once is not missed. */
function foundOver(page: Page, id: string, before: number) {
  return page.waitForResponse(async (r) => {
    if (r.request().method() !== "GET" || !new URL(r.url()).pathname.endsWith(`/api/conversations/${id}/turn`)) {
      return false;
    }
    // A read the page gave up on brings no word.
    const state = await r.json().catch(() => ({ running: true }));
    return state.running === false && state.revision !== before;
  });
}

/** Settles once the page's request for a turn has failed. Called before what makes it fail. */
const answerLost = (page: Page) => page.waitForEvent("requestfailed", {
  predicate: (r) => r.method() === "POST" && new URL(r.url()).pathname.endsWith("/api/chat"),
});

// A phone's link can drop the answer to a reply asked for again once the server has written it: the
// page then finds the turn over without ever seeing it run, and the panel beside it reads all the same.
test("the panel beside the story reads the memory again when a reply written over is found over, its answer lost", { tag: "@desktop" }, async ({ page, request, isMobile }) => {
  test.skip(isMobile, "a phone's panel is closed to reach the reply, and reads on opening");
  const { convo, first, summary, revision, reply } = await readToTheNewestReply(page, request);

  // The server takes the request and writes the reply; its answer is lost on the way back.
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await expect.poll(() => turnRunning(request, convo.id), { timeout: 30_000 }).toBe(false);
    await route.abort("connectionreset");
  });
  const lostAnswer = answerLost(page);
  // What the page asks once it hears of the failure finds the reply already written.
  const over = foundOver(page, convo.id, revision);
  await reply.hover();
  await reply.getByTitle(en.chat.message.regenerateTitle).click();
  await lostAnswer;
  await over;
  await expect(reply.getByText("2/2")).toBeVisible();
  await expect(summary, "the summary the server went back to").toHaveValue(first.summary);
  expect((await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).summary).toBe(first.summary);
});

// A link that leaves a request hanging: the page stops waiting, finds the reply written, and the
// answer dies later still. Nothing is said to the page then; its next look is what tells the panel.
test("the panel beside the story reads the memory again when the answer to a reply written over is lost after the page stopped waiting for it", { tag: "@desktop" }, async ({ page, request, isMobile }) => {
  test.skip(isMobile, "a phone's panel is closed to reach the reply, and reads on opening");
  test.setTimeout(120_000); // the page's patience alone is ten seconds
  const { convo, first, summary, revision, reply } = await readToTheNewestReply(page, request);

  const letGo = await answerHangs(page);
  const over = foundOver(page, convo.id, revision);
  await reply.hover();
  await reply.getByTitle(en.chat.message.regenerateTitle).click();
  // Its patience over, the page looks, and shows the reply already written: the request is unanswered still.
  await over;
  await expect(reply.getByText("2/2")).toBeVisible();
  const lostAnswer = answerLost(page);
  letGo();
  await lostAnswer;

  await expect(summary, "the summary the server went back to").toHaveValue(first.summary);
  expect((await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).summary).toBe(first.summary);
});

// The same link, and a reply slow enough to be still going when the page stops waiting: the page
// watches it to its end, which is when the panel reads, however long the request stays unanswered.
test("the panel beside the story reads the memory again at the end of a slow reply written over, its request unanswered still", { tag: "@desktop" }, async ({ page, request, isMobile }) => {
  test.skip(isMobile, "a phone's panel is closed to reach the reply, and reads on opening");
  test.setTimeout(120_000); // the page's patience, then the rest of a reply at a crawl
  const { convo, first, summary, reply } = await readToTheNewestReply(page, request);
  // After the pass, which a slow model would crawl through too.
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "SLOWLY" } });

  const letGo = await answerHangs(page);
  // The page hears that the reply is being written, then that it no longer is.
  let watched = false;
  const over = page.waitForResponse(async (r) => {
    if (r.request().method() !== "GET") return false;
    if (!new URL(r.url()).pathname.endsWith(`/api/conversations/${convo.id}/turn`)) return false;
    // A read the page gave up on brings no word.
    const { running } = await r.json().catch(() => ({ running: null }));
    if (running) watched = true;
    return watched && running === false;
  });
  await reply.hover();
  await reply.getByTitle(en.chat.message.regenerateTitle).click();
  await over;

  await expect(reply.getByText("2/2")).toBeVisible();
  await expect(summary, "the summary the server went back to").toHaveValue(first.summary);
  expect((await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).summary).toBe(first.summary);
  const lostAnswer = answerLost(page);
  letGo();
  await lostAnswer;
});

// A read is the whole story: the one that ends the turn brings the summary a closed panel opens on.
test("a reply asked for again with the panel closed reads the story once at its end", async ({ page, request }) => {
  const convo = await makeConversation(request);
  const say = (content: string) => chat(request, { conversation_id: convo.id, mode: "send", content });
  const pass = () =>
    request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await say("First question.");
  await pass();
  const first = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  await say("Second question.");
  // Read to the newest reply, which asking for again takes back to the first pass.
  await pass();

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  const panel = page.locator("aside:visible:has(textarea)");
  if (!(await opener.isVisible())) await panel.getByLabel(panelText.closeAriaLabel).click();
  await page.waitForLoadState("networkidle");

  // Reads sent once the server has said the reply is written.
  let ended = false;
  await page.route(`**/api/conversations/${convo.id}/turn`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const state = await route.fetch();
    if (!(await state.json()).running) ended = true;
    await route.fulfill({ response: state });
  });
  const reads: string[] = [];
  page.on("request", (r) => {
    if (ended && r.method() === "GET" && readOf(convo.id)(r.url())) reads.push(r.url());
  });
  const reply = page.locator("[data-message-id]").last();
  // The second version can show before the end, read as the reply goes: the count starts at the end.
  const over = replyEnds(page, convo.id);
  await reply.getByTitle(en.chat.message.regenerateTitle).click();
  await over;
  await expect(reply.getByText("2/2")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(reads, "the story read again once the read that ended the reply was shown").toHaveLength(1);

  // The panel's own read never lands: the summary must be on the page already.
  await page.route(readOf(convo.id), async (route) => {
    if (route.request().method() !== "GET") await route.continue();
  });
  await opener.click();
  await expect(panel.getByPlaceholder(panelText.summary.placeholder)).toHaveValue(first.summary);
});

// Whether the panel is open is asked once the server has answered the swipe, not when it was asked for.
test("a swipe answered once the panel is closed brings it the summary the memory went back to", { tag: "@desktop" }, async ({ page, request, isMobile }) => {
  test.skip(isMobile, "a phone's panel covers the reply");
  const convo = await makeConversation(request);
  const pass = () =>
    request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await chat(request, { conversation_id: convo.id, mode: "send", content: "First question." });
  await pass();
  const first = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  await chat(request, { conversation_id: convo.id, mode: "send", content: "Second question." });
  await chat(request, { conversation_id: convo.id, mode: "regenerate" });
  await pass();

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue(/Read to turn 4/);
  await page.waitForLoadState("networkidle");

  // The swipe is answered once the panel is closed; reopened, the panel's own read never lands.
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/messages/*", async (route) => {
    if (route.request().method() === "PATCH") await released;
    await route.continue();
  });
  let reopened = false;
  await page.route(readOf(convo.id), async (route) => {
    if (!reopened || route.request().method() !== "GET") await route.continue();
  });
  const reads: string[] = [];
  page.on("requestfinished", (r) => {
    if (r.method() === "GET" && readOf(convo.id)(r.url())) reads.push(r.url());
  });
  const reply = page.locator("[data-message-id]").last();
  await reply.hover();
  await reply.getByLabel(en.chat.message.prevVariantAriaLabel).click();
  await panel.getByLabel(panelText.closeAriaLabel).click();
  release();
  await expect.poll(() => reads.length, { message: "the summary read for the closed panel" }).toBe(1);

  reopened = true;
  await page.locator("header button:has(svg.lucide-sliders-horizontal)").click();
  await expect(summary).toHaveValue(first.summary);
});

// The directive's save and the summary's read go out together; the read must not undo the save.
test("a read sent with the directive's save does not put the old directive back", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await chat(request, { conversation_id: convo.id, mode: "send", content: "First question." });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const directive = panel.getByPlaceholder(panelText.directive.placeholder);
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue("");
  await page.waitForLoadState("networkidle");
  // Something new for the read to bring, which shows when it has landed.
  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });

  // The read is answered from the database as it was before the save, and lands after it.
  let readAnswered = () => {};
  const answered = new Promise<void>((resolve) => { readAnswered = resolve; });
  let saveShown = () => {};
  const shown = new Promise<void>((resolve) => { saveShown = resolve; });
  await page.route(readOf(convo.id), async (route) => {
    if (route.request().method() === "PATCH") {
      await answered;
      await route.continue();
      return;
    }
    const before = await route.fetch();
    readAnswered();
    await shown;
    await route.fulfill({ response: before });
  });

  await directive.fill("Fog, lamplight, nothing resolved tonight.");
  await summary.click();
  await expect(panel.getByRole("button", { name: panelText.directive.applyButton })).toBeHidden();
  saveShown();

  await expect(summary).toHaveValue(/woke the character in a crypt/);
  await expect(directive).toHaveValue("Fog, lamplight, nothing resolved tonight.");
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.author_note).toBe("Fog, lamplight, nothing resolved tonight.");
});

test("an older read, given up once a newer one is sent, does not put back the summary that one brought", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await chat(request, { conversation_id: convo.id, mode: "send", content: "First question." });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue("");
  await page.waitForLoadState("networkidle");

  // The read of a wake is answered before the pass, and its answer held until after the summary box's read.
  let fetched = () => {};
  const answered = new Promise<void>((resolve) => { fetched = resolve; });
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  await page.route(readOf(convo.id), async (route) => {
    if (route.request().method() !== "GET" || ++reads > 1) return route.continue();
    const old = await route.fetch();
    fetched();
    await released;
    await route.fulfill({ response: old }).catch(() => {}); // given up on by then
  });
  // Listened for before the read starts: however early it is given up, that is not missed.
  const givenUp = page.waitForEvent("requestfailed", {
    predicate: (r) => readOf(convo.id)(r.url()),
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await answered;
  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await summary.click();
  await expect(summary).toHaveValue(/woke the character in a crypt/);
  const brought = await summary.inputValue();
  await givenUp;

  release();
  await page.waitForTimeout(500);
  await expect(summary).toHaveValue(brought);
});

// A wake fires two events.
test("a phone waking reads the conversation once, and only for the panel it shows", async ({ page, request, isMobile }) => {
  test.skip(!isMobile, "a wide screen's panel is open from the start");
  const convo = await makeConversation(request);
  const isRead = (r: Request) => r.method() === "GET" && readOf(convo.id)(r.url());
  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const reads: string[] = [];
  page.on("request", (r) => {
    if (isRead(r)) reads.push(r.url());
  });
  const wake = async () => {
    reads.length = 0;
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForTimeout(1500);
    return reads.length;
  };

  expect(await wake(), "reads for a panel nobody sees").toBe(0);

  const opened = page.waitForResponse((r) => isRead(r.request()));
  await page.locator("header button:has(svg.lucide-sliders-horizontal)").click();
  await opened;
  expect(await wake(), "reads for the panel over the conversation").toBe(1);
});

// A failed pass is told until one works, even a Remember that finds nothing to summarize.
test("a Remember that works takes away the error of a pass that failed before it", async ({ page, request }) => {
  const convo = await makeConversation(request);
  // How the conversation reports the failed pass, until one works.
  let failing = true;
  await page.route(readOf(convo.id), async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    const failure = { error: "Cannot reach the model.", kind: "unreachable" };
    await route.fulfill({ response, json: failing ? { ...body, memory_error: failure } : body });
  });
  await page.route("**/memories/extract", async (route) => {
    failing = false;
    await route.continue();
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const error = panel.locator("p.text-blood");
  await expect(error).toBeVisible();

  // Nothing in the story to read yet: it works, and writes no summary.
  await panel.getByRole("button", { name: panelText.facts.extractButton, exact: true }).click();

  await expect(panel.locator("p.text-moss")).toBeVisible();
  await expect(error).toBeHidden();
});

test("pinning or forgetting a fact takes away the error a failed Remember left", async ({ page, request }) => {
  const convo = await makeConversation(request);
  for (const content of ["She keeps the key.", "The ferry runs on Tuesdays."]) {
    await request.post(`${API}/api/conversations/${convo.id}/memories`, { data: { content } });
  }
  await page.route("**/memories/extract", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Cannot reach the model.", kind: "unreachable" }),
    }),
  );

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel).toContainText("She keeps the key.");
  const remember = panel.getByRole("button", { name: panelText.facts.extractButton, exact: true });
  const error = panel.locator("p.text-blood");

  await remember.click();
  await expect(error).toBeVisible();
  await panel.getByTitle(panelText.facts.pinTitle).first().click();
  await expect(error).toBeHidden();

  await remember.click();
  await expect(error).toBeVisible();
  await panel.getByLabel(panelText.facts.forgetAriaLabel).first().click();
  await expect(error).toBeHidden();
  await expect(panel).toContainText("(1)");
});

test("a memory pass that fails says so in the colour of an error, and keeps saying it", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await page.route("**/memories/extract", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Cannot reach the model.", kind: "unreachable" }),
    }),
  );

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");

  await panel.getByRole("button", { name: panelText.facts.extractButton, exact: true }).click();

  const error = panel.locator("p.text-blood");
  await expect(error).toBeVisible();
  await page.waitForTimeout(4500);
  await expect(error).toBeVisible();
});

test("a read of the facts that a pin overtook does not unpin it", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/conversations/${convo.id}/memories`, { data: { content: "She keeps the key." } });
  await page.route("**/memories/extract", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Cannot reach the model.", kind: "unreachable" }),
    }),
  );

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel).toContainText("She keeps the key.");

  // The read that follows the failed Remember is answered as the facts were, and delivered after the pin.
  let fetched = () => {};
  const answered = new Promise<void>((resolve) => { fetched = resolve; });
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/conversations/${convo.id}/memories`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const old = await route.fetch();
    fetched();
    await released;
    await route.fulfill({ response: old });
  });
  await panel.getByRole("button", { name: panelText.facts.extractButton, exact: true }).click();
  await answered;
  await panel.getByTitle(panelText.facts.pinTitle).click();
  await expect(panel.getByTitle(panelText.facts.unpinTitle)).toBeVisible();

  const late = page.waitForResponse((r) => r.url().endsWith(`/api/conversations/${convo.id}/memories`));
  release();
  await (await late).finished();
  await page.waitForTimeout(500);
  await expect(panel.getByTitle(panelText.facts.unpinTitle)).toBeVisible();
});

test("a merge with too few facts says why, in the colour of an error", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/conversations/${convo.id}/memories`, { data: { content: "She keeps the key." } });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");

  await panel.getByRole("button", { name: panelText.facts.consolidateButton, exact: true }).click();

  await expect(panel.locator("p.text-blood")).toHaveText(en.errors.tooFewFacts);
  await expect(panel).toContainText("She keeps the key.");
});

test("a fact written as the model holds it becomes the person's, and is listed once", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "First question.", message_mode: "say" },
    timeout: 60_000,
  });
  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  const held = (await (await request.get(`${API}/api/conversations/${convo.id}/memories`)).json())[0];

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel).toContainText("(2)");

  const input = panel.getByPlaceholder(panelText.facts.addPlaceholder);
  await input.fill(held.content);
  await input.press("Enter");

  await expect(panel.getByTitle(panelText.facts.unpinTitle)).toHaveCount(1);
  await expect(panel).toContainText("(2)");
  const facts = await (await request.get(`${API}/api/conversations/${convo.id}/memories`)).json();
  expect(facts.find((f: { id: string }) => f.id === held.id)).toMatchObject({ source: "user", is_pinned: true });
});

test("a fact that is gone says so when it is pinned, and leaves the list", async ({ page, request }) => {
  const convo = await makeConversation(request);
  const made = await request.post(`${API}/api/conversations/${convo.id}/memories`, {
    data: { content: "She keeps the key." },
  });
  const fact = await made.json();

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel).toContainText("She keeps the key.");

  // Taken out behind the panel's back, as a pass of the memory or a cut in the story can.
  await request.delete(`${API}/api/memories/${fact.id}`);
  await panel.getByTitle("Pin (always injected)").click();

  await expect(panel).toContainText("This fact no longer exists.");
  await expect(panel).not.toContainText("She keeps the key.");
});
