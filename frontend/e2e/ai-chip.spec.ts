import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import {
  MOCK, MOCK_ROOT, addModel, chat, conversation, conversationWithReply, forgetServices, makeConversation, replyEnds,
  stopTurn,
} from "./fixtures";

/**
 * The AI that answers a conversation, under its input: the chip that names it, the sheet that
 * changes it, and what the conversation says of it in passing. The mock server answers a body that
 * holds MOCK_SAYS_<word> with that word (scripts/mock_llm.py): an AI whose model is MOCK_SAYS_Sylve
 * answers "Sylve", which tells its replies from those of the suite's own AI, "e2e".
 */

const MANY = `${MOCK_ROOT}/many/api/v1`;
const HINT_KEYBOARD = "Enter to send · Shift+Enter for a new line · quill: the AI drafts your reply";
const HINT_TOUCH = "Tap send when you are ready. The quill drafts your reply.";

/** An AI of its own word, on the mock's plain address: added once, the same one after. */
const sylve = (request: APIRequestContext) => addModel(request, { base_url: MOCK, model: "MOCK_SAYS_Sylve", name: "Sylve" });

const chipOf = (page: Page) => page.locator("[data-status-row]").getByRole("button").first();
const sheetOf = (page: Page) => page.getByRole("dialog", { name: "Which AI answers?" });
const toastOf = (page: Page) => page.locator("[data-chat-toast]");
const addDialog = (page: Page) => page.getByRole("dialog", { name: "Add an AI" });

async function noSidewaysScroll(page: Page) {
  const wider = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(wider, "the page scrolls sideways").toBeLessThanOrEqual(0);
}

/** An AI keeping a ceiling of 1,024 tokens of its own, under a name of its own. */
const capped = (request: APIRequestContext, name: string) => addModel(request, {
  base_url: MOCK, model: `e2e-capped-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name,
  changes: { reply_cap: { mode: "fixed", tokens: 1024 } },
});

/** The page reads the settings as asking long replies, whose 2,048 tokens a ceiling of 1,024 would cut:
 *  the suite's settings are shared between tests, so they are changed for this page alone. */
async function longReplies(page: Page) {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const read = await route.fetch();
    await route.fulfill({ response: read, json: { ...(await read.json()), reply_length: "long" } });
  });
}

/** Counted at once, once the toast's words are in: drawn with its words, a button would be there
 *  already, and waiting would only see the toast go. */
async function noButtonIn(toast: Locator) {
  expect(await toast.getByRole("button").count(), "the toast offers a button").toBe(0);
}

/** The ai sheet, opened from the chip. */
async function openSheet(page: Page) {
  await chipOf(page).click();
  await expect(sheetOf(page)).toBeVisible();
  return sheetOf(page);
}

test("switching ai is two taps and the new one answers the next turn", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const other = await sylve(request);
  await page.goto(`/#/chat/${convo.id}`);
  const chip = chipOf(page);
  await expect(chip).toHaveAccessibleName("AI: e2e. Change.");

  const sheet = await openSheet(page);
  await expect(sheet).toContainText("For this conversation only.");
  await expect(sheet.getByRole("radio", { name: /^e2e/ })).toHaveAttribute("aria-checked", "true");
  await sheet.getByRole("radio", { name: /^Sylve/ }).click();
  await expect(sheet).toHaveCount(0);
  await expect(chip).toHaveAccessibleName(`AI: ${other.name}. Change.`);
  await expect(toastOf(page)).toContainText(`${other.name} answers from now on.`);
  expect((await conversation(request, convo.id)).model_id).toBe(other.id);

  await page.locator("textarea").first().fill("And you?");
  const ends = replyEnds(page, convo.id);
  await page.locator('button[title="Send"]').click();
  await ends;
  await expect(page.locator("[data-message-id]").last()).toContainText("Sylve one two three");
});

test("a switch that fails keeps the sheet open and the chip as it was", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await sylve(request);
  await page.route(`**/api/conversations/${convo.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, contentType: "text/html", body: "<html>Server error</html>" })
      : route.continue());
  await page.goto(`/#/chat/${convo.id}`);

  const sheet = await openSheet(page);
  const row = sheet.getByRole("radio", { name: /^Sylve/ });
  await row.click();
  await expect(sheet.getByRole("alert")).not.toBeEmpty();
  await expect(sheet).toBeVisible();
  await expect(row).toHaveAttribute("aria-checked", "false");
  await expect(row).not.toHaveAttribute("aria-busy", "true");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(chipOf(page)).toHaveAccessibleName("AI: e2e. Change.");
  expect((await conversation(request, convo.id)).model_id).not.toBe((await sylve(request)).id);
});

test("with a keyboard the keyboard sentence sits right of the chip", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await makeConversation(request);
  await page.goto(`/#/chat/${convo.id}`);
  const row = page.locator("[data-status-row]");
  await expect(chipOf(page)).toBeVisible();

  if (test.info().project.name === "desktop") {
    const hint = row.getByText(HINT_KEYBOARD);
    await expect(hint).toBeVisible();
    const chip = (await chipOf(page).boundingBox())!;
    const said = (await hint.boundingBox())!;
    expect(said.x, "the sentence is not right of the chip").toBeGreaterThanOrEqual(chip.x + chip.width);
    expect(said.y, "the sentence is not on the chip's line").toBeLessThan(chip.y + chip.height);
  } else {
    // A touch screen: the chip takes the sentence's place.
    await expect(page.getByText(HINT_KEYBOARD)).toHaveCount(0);
    await expect(page.getByText(HINT_TOUCH)).toHaveCount(0);
  }
});

test("each row of the ai sheet keeps its price", async ({ page, request }) => {
  const convo = await makeConversation(request);
  const priced = await addModel(request, {
    base_url: MOCK, model: "e2e-priced", name: "Priced one", changes: { price_own_in: 3, price_own_out: 15 },
  });
  const made = await request.post(`${API}/api/models`, {
    data: {
      service: { provider: "openai-compatible", base_url: `${MOCK_ROOT}/lmstudio/v1`, api_key: "sk-ai-chip", family: "lmstudio" },
      models: [{ model: "brume-12b", name: "Home brume" }],
    },
  });
  expect(made.ok()).toBe(true);
  const home = (await made.json()).models[0];
  await page.goto(`/#/chat/${convo.id}`);

  const sheet = await openSheet(page);
  await expect(sheet.getByRole("radio", { name: new RegExp(`^${priced.name}`) }))
    .toContainText("$3 read, $15 written, per million tokens");
  await expect(sheet.getByRole("radio", { name: new RegExp(`^${home.name}`) })).toContainText("LM Studio, on this PC");
  await expect(sheet.getByRole("radio", { name: new RegExp(`^${home.name}`) })).toContainText("free");
  await sheet.getByRole("button", { name: "Close" }).click();
  const row = page.locator("[data-status-row]");
  await expect(row).not.toContainText("$");
  await expect(row).not.toContainText("free");
});

test("redo the last reply with the new ai keeps the old one beside it", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const before = (await conversation(request, convo.id)).messages.at(-1).content;
  const other = await sylve(request);
  await page.goto(`/#/chat/${convo.id}`);

  const sheet = await openSheet(page);
  await sheet.getByRole("radio", { name: /^Sylve/ }).click();
  const toast = toastOf(page);
  await expect(toast).toContainText(`${other.name} answers from now on.`);
  const ends = replyEnds(page, convo.id);
  await toast.getByRole("button", { name: "Redo the last reply" }).click();
  await ends;

  await expect(toast).toContainText(`Last reply redone by ${other.name}. The old one stays beside it.`);
  const reply = page.locator("[data-message-id]").last();
  await expect(reply).toContainText("Sylve one two three");
  await expect(reply).toContainText("2/2");
  const read = (await conversation(request, convo.id)).messages.at(-1);
  expect(read.variants).toHaveLength(2);
  expect(read.variants[0]).toBe(before);
});

test("no redo button when the last message is the person's or a reply is being written", async ({ page, request }) => {
  await sylve(request);
  // A message whose reply failed: the last one is the person's.
  const unanswered = await makeConversation(request);
  await request.patch(`${API}/api/conversations/${unanswered.id}`, { data: { author_note: "MOCK_FAILS" } });
  await chat(request, { conversation_id: unanswered.id, mode: "send", content: "Anyone?" });
  await request.patch(`${API}/api/conversations/${unanswered.id}`, { data: { author_note: "" } });
  expect((await conversation(request, unanswered.id)).messages.at(-1).role).toBe("user");
  await page.goto(`/#/chat/${unanswered.id}`);
  let sheet = await openSheet(page);
  await sheet.getByRole("radio", { name: /^Sylve/ }).click();
  await expect(toastOf(page)).toContainText("Sylve answers from now on.");
  await noButtonIn(toastOf(page));

  const slow = await conversationWithReply(request, { slowly: true });
  await page.goto(`/#/chat/${slow.id}`);
  await page.locator("textarea").first().fill("Go on.");
  await page.locator('button[title="Send"]').click();
  await expect(page.locator('button[title="Stop generation"]')).toBeVisible();
  try {
    sheet = await openSheet(page);
    await sheet.getByRole("radio", { name: /^Sylve/ }).click();
    await expect(toastOf(page)).toContainText("Sylve answers from now on.");
    await noButtonIn(toastOf(page));
  } finally {
    await stopTurn(request, slow.id);
  }
});

test("the redo button goes as soon as a reply is being written", async ({ page, request }) => {
  await sylve(request);
  const slow = await conversationWithReply(request, { slowly: true });
  await page.goto(`/#/chat/${slow.id}`);
  const sheet = await openSheet(page);
  await sheet.getByRole("radio", { name: /^Sylve/ }).click();
  const redo = toastOf(page).getByRole("button", { name: "Redo the last reply" });
  await expect(redo).toBeVisible();

  await page.locator("textarea").first().fill("Go on.");
  await page.locator('button[title="Send"]').click();
  try {
    await expect(page.locator('button[title="Stop generation"]')).toBeVisible();
    // At once, not when the toast's time runs out: the words stay, the button goes.
    await expect(redo).toHaveCount(0, { timeout: 1500 });
    await expect(toastOf(page)).toContainText("Sylve answers from now on.");
  } finally {
    await stopTurn(request, slow.id);
  }
});

test("a toast is heard through the page's one status line", async ({ page, request }) => {
  await sylve(request);
  const convo = await makeConversation(request);
  await page.goto(`/#/chat/${convo.id}`);
  const sheet = await openSheet(page);
  await sheet.getByRole("radio", { name: /^Sylve/ }).click();
  await expect(toastOf(page)).toContainText("Sylve answers from now on.");
  expect(await page.getByRole("status").count(), "status elements while the toast shows").toBe(1);
  await expect(page.getByRole("status")).toContainText("Sylve answers from now on.");
});

test("a capped ai is said in the sheet, and letting Evermind set it is confirmed in view", async ({ page, request }) => {
  const convo = await makeConversation(request);
  // Short names, which the sheet does not cut in the middle.
  const mine = await capped(request, `Ardoise ${Math.random().toString(36).slice(2, 6)}`);
  const other = await capped(request, `Basalte ${Math.random().toString(36).slice(2, 6)}`);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: mine.id } });
  await longReplies(page);
  await page.goto(`/#/chat/${convo.id}`);

  const sheet = await openSheet(page);
  await expect(sheet).toContainText(
    `${mine.name} keeps a ceiling of 1,024 tokens per reply, in all its conversations: long replies would be cut short.`,
  );
  await expect(sheet.getByRole("radio", { name: new RegExp(`^${other.name}`) }))
    .toContainText("Replies cut at 1,024 tokens as long as its ceiling is not lifted.");
  await expect(sheet.getByRole("radio", { name: new RegExp(`^${mine.name}`) })).not.toContainText("Replies cut at");

  await sheet.getByRole("button", { name: "Let Evermind set it" }).click();
  const said = `${mine.name} no longer has a ceiling of its own: Evermind keeps the room it needs.`;
  await expect(toastOf(page)).toContainText(said);
  await expect(toastOf(page)).toBeInViewport();
  await expect(sheet).toHaveCount(0);
  const ais = await (await request.get(`${API}/api/models`)).json();
  expect(ais.find((ai: { id: string }) => ai.id === mine.id).reply_cap.mode).toBe("auto");

  // Opened again, the sheet no longer warns of it.
  await openSheet(page);
  await expect(sheetOf(page)).not.toContainText("keeps a ceiling of");
});

test("another model from the conversation is six taps and comes back with it chosen", async ({ page, request }) => {
  await forgetServices(request, "/many/");
  const listed = await request.post(`${API}/api/connections/probe`, {
    data: { provider: "openai-compatible", base_url: MANY, api_key: "sk-e2e-any", family: "openrouter" },
  });
  const rows: { id: string; name: string }[] = (await listed.json()).models;
  const eclair = rows.find((r) => r.name === "Eclair Mini")!;
  const first = rows.find((r) => r.id !== eclair.id)!;
  const made = await request.post(`${API}/api/models`, {
    data: {
      service: { provider: "openai-compatible", base_url: MANY, api_key: "sk-e2e-six", family: "openrouter" },
      models: [{ model: first.id }],
    },
  });
  expect(made.ok()).toBe(true);
  const convo = await makeConversation(request);
  await page.goto(`/#/chat/${convo.id}`);

  await chipOf(page).click(); // 1
  await sheetOf(page).getByRole("button", { name: "Other model…" }).click(); // 2
  const box = addDialog(page);
  await box.getByRole("button", { name: /Already connected · 1 AI/ }).filter({ hasText: "/many/" }).click(); // 3
  const search = box.getByRole("searchbox");
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();
  await search.click(); // 4
  await search.pressSequentially("eclair");
  await box.locator("li").filter({ has: page.getByText(eclair.id, { exact: true }) }).getByRole("checkbox").check(); // 5
  await box.getByRole("button", { name: "Add and answer with Eclair Mini" }).click(); // 6

  await expect(box).toHaveCount(0);
  await expect(chipOf(page)).toHaveAccessibleName("AI: Eclair Mini. Change.");
  const now = await conversation(request, convo.id);
  const ais = await (await request.get(`${API}/api/models`)).json();
  expect(ais.find((ai: { id: string }) => ai.id === now.model_id).model).toBe(eclair.id);
});

test("a long name is cut in the middle and the row wraps rather than hide", async ({ page, request }) => {
  const convo = await makeConversation(request);
  const long = await addModel(request, { base_url: MOCK, model: "e2e-obsidienne", name: "Obsidienne R1 Distill Llama 70B Instruct" });
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: long.id } });
  for (const [width, height] of [[360, 740], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`/#/chat/${convo.id}`);
    const chip = chipOf(page);
    await expect(chip).toHaveAccessibleName(`AI: ${long.name}. Change.`);
    const end = chip.getByText("Instruct");
    await expect(end, `at ${width}px`).toBeVisible();
    const box = (await end.boundingBox())!;
    expect(box.x + box.width, `the end of the name is off the screen at ${width}px`).toBeLessThanOrEqual(width);
    // Whatever shares the row goes to a line of its own rather than off the screen.
    for (const said of await page.locator("[data-status-row] > *").all()) {
      const edge = (await said.boundingBox())!;
      expect(edge.x + edge.width, `something on the row is off the screen at ${width}px`).toBeLessThanOrEqual(width);
    }
    await noSidewaysScroll(page);
  }
});

test("an ai removed elsewhere is said once, and the default answers", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const gone = await addModel(request, { base_url: MOCK, model: `e2e-gone-${Date.now()}`, name: `Gone ${Date.now()}` });
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: gone.id } });
  expect((await request.delete(`${API}/api/models/${gone.id}`)).ok()).toBe(true);
  await page.goto(`/#/chat/${convo.id}`);

  const line = page.locator("[data-model-lost]");
  await expect(line).toContainText(`${gone.name} was removed from your AIs: e2e answers in its place.`);
  await expect(chipOf(page)).toHaveAccessibleName("AI: e2e. Change.");
  const seen = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/conversations/${convo.id}`));
  await line.getByRole("button", { name: "Got it" }).click();
  await seen;
  await expect(line).toHaveCount(0);
  await page.reload();
  await expect(chipOf(page)).toBeVisible();
  await expect(line).toHaveCount(0);

  // With none left, it says so, and the chip adds one.
  await page.route("**/api/models", (route) => (route.request().method() === "GET" ? route.fulfill({ json: [] }) : route.continue()));
  await page.route(`**/api/conversations/${convo.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const read = await route.fetch();
    await route.fulfill({ response: read, json: { ...(await read.json()), model_lost: "Gone one" } });
  });
  await page.reload();
  await expect(line).toContainText("Gone one was removed from your AIs, and none is left.");
  await expect(chipOf(page)).toHaveText("Add an AI");
});

test("with no ai the chip adds one in place", async ({ page, request }) => {
  const convo = await makeConversation(request);
  // The suite's server is shared between tests: the list is emptied for this page alone.
  await page.route("**/api/models", (route) => (route.request().method() === "GET" ? route.fulfill({ json: [] }) : route.continue()));
  await page.goto(`/#/chat/${convo.id}`);
  const chip = chipOf(page);
  await expect(chip).toHaveText("Add an AI");
  await chip.click();
  await expect(addDialog(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/chat/${convo.id}$`));
  await addDialog(page).getByRole("button", { name: "Close" }).click();
  await expect(addDialog(page)).toHaveCount(0);
});
