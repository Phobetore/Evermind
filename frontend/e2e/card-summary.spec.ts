import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter, makeConversation } from "./fixtures";

/** From a conversation, and from the list of them, the card it is played with is one tap away. */

/** A conversation played as a persona of its own, Corvin. A decoy made first takes the default, in a
 *  clean run, so that {{user}} reading "Corvin" proves the conversation's persona was used, not the
 *  default one. `done` deletes them all, test passed or not. */
async function withPersona(request: APIRequestContext, fields: Record<string, unknown>) {
  const persona = async (name: string) =>
    (await (await request.post(`${API}/api/personas`, { data: { name, description: "Made by card-summary.spec." } })).json()).id as string;
  const decoy = await persona("Decoy");
  const corvin = await persona("Corvin");
  const character = await makeCharacter(request, fields);
  const convo = (await (await request.post(`${API}/api/conversations`, {
    data: { character_id: character.id, persona_id: corvin },
  })).json()) as { id: string; character_id: string };
  const done = async () => {
    await request.delete(`${API}/api/conversations/${convo.id}`);
    for (const id of [corvin, decoy]) await request.delete(`${API}/api/personas/${id}`);
  };
  return { convo, done };
}

test("the avatar at the top of a conversation opens its card in short, and leads to the card and back", async ({ page, request }) => {
  const { convo, done } = await withPersona(request, {
    name: "Ilse",
    tagline: "{{char}} keeps the lighthouse",
    description: "She counts the ships that do not come back, and tells {{user}} their names.",
    tags: ["sea", "night"],
  });
  try {
    await page.goto(`/#/chat/${convo.id}`);

    const avatar = page.locator("header").getByRole("button", { name: "About Ilse" });
    await avatar.click();
    const summary = page.getByRole("dialog", { name: "Ilse" });
    await expect(summary.getByText("Character", { exact: true })).toBeVisible();
    // The macros read as they will in the story: {{user}} is the persona this conversation is played as.
    await expect(summary.getByText("Ilse keeps the lighthouse", { exact: true })).toBeVisible();
    await expect(summary.getByText("She counts the ships that do not come back, and tells Corvin their names.")).toBeVisible();
    await expect(summary.getByText("sea", { exact: true })).toBeVisible();
    await expect(summary.getByText("night", { exact: true })).toBeVisible();

    // Closed, it hands the focus back to what opened it.
    await page.keyboard.press("Escape");
    await expect(summary).toBeHidden();
    await expect(avatar).toBeFocused();

    await avatar.click();
    await summary.getByRole("link", { name: "Open the card" }).click();
    await expect(page).toHaveURL(new RegExp(`#/characters/${convo.character_id}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Ilse" })).toBeVisible();
    // The tagline reads the same on the card as in the summary.
    await expect(page.getByText("Ilse keeps the lighthouse", { exact: true })).toBeVisible();

    // The way back: the card lists its conversations, this one alone.
    const back = page
      .locator("main section", { has: page.getByRole("heading", { name: "Your conversations" }) })
      .getByRole("button");
    await expect(back).toHaveCount(1);
    await back.click();
    await expect(page).toHaveURL(new RegExp(`#/chat/${convo.id}$`));
  } finally {
    await done();
  }
});

/** The room each row's name gets, both read at once. Both names are longer than their line, so what
 *  each gets is its line's room, less what sits beside it. */
function roomOfNames(page: Page, ids: [string, string]) {
  return page.evaluate(
    (rows) => rows.map((id) => document.querySelector(`a[href="#/chat/${id}"] h2`)!.clientWidth),
    ids,
  );
}

test("the list says which card each conversation is with, and its avatar opens that card in short", async ({ page, request }) => {
  const { convo: ballChat, done } = await withPersona(request, {
    name: "The Masked Ball of the Winter Court",
    kind: "scenario",
    description: "A ball where {{user}} wears a borrowed mask.",
  });
  const ottoChat = await makeConversation(request, { name: "Ottoline Featherstonehaugh-Wyndham" });
  try {
    await page.goto("/#/chat");
    const ball = page.locator(`a[href="#/chat/${ballChat.id}"]`);
    const otto = page.locator(`a[href="#/chat/${ottoChat.id}"]`);
    await expect(otto).toBeVisible();
    await expect(ball.getByText("Scenario", { exact: true })).toHaveCount(1);
    await expect(otto.getByText("Scenario", { exact: true })).toHaveCount(0);

    // On a phone the mark is its icon, the word kept for a screen reader, and the time goes to the
    // second line: a scenario's name gives up no more than the icon, down to a narrow phone.
    await expect(ball.locator("svg.lucide-book-open-text")).toBeVisible();
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 800 });
      const [ballRoom, ottoRoom] = await roomOfNames(page, [ballChat.id, ottoChat.id]);
      expect(ballRoom, `at ${width}px the scenario's name has ${ballRoom}px, a character's ${ottoRoom}px`)
        .toBeGreaterThanOrEqual(ottoRoom - 36);
      expect(ballRoom, `at ${width}px`).toBeGreaterThan(40);
    }

    // The avatar opens the card in short, as in the conversation's header; the row does not open.
    await ball.getByRole("button", { name: "About The Masked Ball of the Winter Court" }).click();
    const summary = page.getByRole("dialog", { name: "The Masked Ball of the Winter Court" });
    await expect(summary.getByText("Scenario", { exact: true })).toBeVisible();
    await expect(summary.getByText("A ball where Corvin wears a borrowed mask.")).toBeVisible();
    await expect(page).toHaveURL(/#\/chat$/);
    await summary.getByRole("link", { name: "Open the card" }).click();
    await expect(page).toHaveURL(new RegExp(`#/characters/${ballChat.character_id}$`));
    await expect(page.getByRole("heading", { level: 1, name: "The Masked Ball of the Winter Court" })).toBeVisible();

    // The rest of the row still opens the conversation.
    await page.goBack();
    await otto.locator("h2").click();
    await expect(page).toHaveURL(new RegExp(`#/chat/${ottoChat.id}$`));
  } finally {
    await done();
  }
});

test("a one-word name wraps in the summary's title rather than being cut or pushing it off a narrow phone", async ({ page, request }) => {
  const name = "Nachtigallenköniginnenthronsaalwächterin";
  const convo = await makeConversation(request, { name });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("header").getByRole("button", { name: `About ${name}` }).click();

  const dialog = page.getByRole("dialog", { name });
  const panel = dialog.locator(".panel");
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth), "the summary scrolls sideways").toBe(0);
  const title = dialog.getByRole("heading", { name });
  expect(await title.evaluate((el) => el.scrollWidth - el.clientWidth), "the name is cut").toBe(0);
  expect(await title.evaluate((el) => el.getBoundingClientRect().height), "the name did not wrap").toBeGreaterThan(32);
  const close = (await dialog.getByRole("button", { name: "Close" }).boundingBox())!;
  expect(close.x + close.width, "Close is off the screen").toBeLessThanOrEqual(320);
});

// The cards the tests below sow, deleted after each with their conversations: the home page of
// every later test would draw them.
const made: string[] = [];
// What reached the sites of the tests.
const asked: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`${API}/api/characters/${id}`);
  asked.length = 0;
});

/** A conversation of a new card named Ilse, its summary opened from the conversation's header. */
async function summaryOf(page: Page, request: APIRequestContext, fields: Record<string, unknown>) {
  await page.context().route(/^https:\/\/[^/]*\.example\//, (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 404 });
  });
  const convo = await makeConversation(request, { name: "Ilse", ...fields });
  made.push(convo.character_id);
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("header").getByRole("button", { name: "About Ilse" }).click();
  const summary = page.getByRole("dialog", { name: "Ilse" });
  await expect(summary).toBeVisible();
  return summary;
}

test("the summary shows the author's presentation in plain words", async ({ page, request }) => {
  const summary = await summaryOf(page, request, {
    creator_notes: '**Lighthouse** keeper <img src="https://pictures.example/a.png">',
    description: "A description the model reads.",
  });
  await expect(summary.getByText("Lighthouse keeper")).toBeVisible();
  await expect(summary).not.toContainText("**");
  await expect(summary).not.toContainText("<img");
  await expect(summary).not.toContainText("A description the model reads.");
  expect(asked.filter((url) => new URL(url).hostname === "pictures.example")).toEqual([]);
});

test("the summary reads the card's name markers", async ({ page, request }) => {
  const summary = await summaryOf(page, request, { creator_notes: "<p><BOT> keeps the **light**</p>" });
  await expect(summary.getByText("Ilse keeps the light")).toBeVisible();
});

test("the summary shows a description as the model reads it", async ({ page, request }) => {
  const summary = await summaryOf(page, request, { description: "{{// x}} <USER> meets {{char}}" });
  await expect(summary.getByText("{{// x}} <USER> meets Ilse")).toBeVisible();
});

test("the summary keeps its button in reach on a phone", async ({ page, request }) => {
  const long = "a".repeat(10_000);
  const summary = await summaryOf(page, request, {
    tagline: long,
    tags: [long, ...Array.from({ length: 999 }, (_, i) => `tag ${i}`)],
  });
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth),
    "the page scrolls sideways",
  ).toBeLessThanOrEqual(0);
  const panel = summary.locator(".panel");
  expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth), "the summary scrolls sideways").toBeLessThanOrEqual(0);
  const tagline = summary.locator("p.italic");
  expect(
    await tagline.evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
  ).toBeLessThanOrEqual(3.5);
  await expect(summary.locator("span.truncate[title]")).toHaveCount(8);
  await expect(summary.getByRole("button", { name: "Show the 992 other tags" })).toHaveText("+992");
  await expect(summary.getByRole("link", { name: "Open the card" })).toBeInViewport();
});
