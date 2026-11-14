import { expect, test, type APIRequestContext, type Locator, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API } from "../playwright.config";
import { LAYOUT_BOUND, PLAIN_PART } from "../src/lib/presentation/bounds";
import { makeCharacter, makeConversation, policyViolations, watchPolicy } from "./fixtures";

/** A card's page: the author's presentation first, then the openings, then what the model reads,
 *  folded; each text of the card bounded where it could push the page out of reach, freeze it, or
 *  paint over it. */

const en = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "src", "i18n", "locales", "en.json"), "utf8"));

// The cards each test sows, deleted after it with their conversations: the home page of every
// later test would draw them.
const made: string[] = [];
// What the page has thrown, and what reached the sites of the tests.
const thrown: string[] = [];
const asked: Request[] = [];

test.beforeEach(async ({ page, context }) => {
  thrown.length = 0;
  asked.length = 0;
  page.on("pageerror", (error) => thrown.push(error.message));
  await context.route(/^https:\/\/([^/]*\.)?example(\.com)?\//, (route) => {
    asked.push(route.request());
    return route.fulfill({ status: 404 });
  });
});

test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`${API}/api/characters/${id}`);
});

/** A card named Ilse unless told otherwise, deleted after the test. */
async function card(request: APIRequestContext, fields: Record<string, unknown> = {}) {
  const sown = (await makeCharacter(request, { name: "Ilse", ...fields })) as { id: string; name: string };
  made.push(sown.id);
  return sown;
}

/** A conversation of a new card named Ilse unless told otherwise; the card is deleted after the test. */
async function conversationOf(request: APIRequestContext, fields: Record<string, unknown> = {}) {
  const convo = await makeConversation(request, { name: "Ilse", ...fields });
  made.push(convo.character_id);
  return convo as { id: string; character_id: string };
}

async function openPage(page: Page, id: string, name = "Ilse") {
  await page.goto(`/#/characters/${id}`);
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}

const section = (page: Page, heading: string) =>
  page.locator("section", { has: page.getByRole("heading", { level: 2, name: heading, exact: true }) });
const opening = (page: Page) => section(page, "Opening");
const author = (page: Page) => page.getByRole("region", { name: "From the author" });
const modelReads = (page: Page) => page.locator("details", { has: page.locator("summary", { hasText: "What the model reads" }) });

async function openModelReads(page: Page): Promise<Locator> {
  await page.locator("summary", { hasText: "What the model reads" }).click();
  const details = modelReads(page);
  await expect(details.getByText(en.characters.detail.modelReadsHint)).toBeVisible();
  return details;
}

/** A field of what the model reads, by the form's name for it: its heading and its text. */
const field = (details: Locator, label: string) =>
  details.getByRole("heading", { level: 3, name: label, exact: true }).locator("xpath=..");

/** How long a step takes to be seen through, in milliseconds. */
async function timed(step: () => Promise<unknown>): Promise<number> {
  const start = Date.now();
  await step();
  return Date.now() - start;
}

const start = (page: Page) => page.getByRole("button", { name: "Start a conversation" });
const composer = (page: Page) => page.locator("textarea").first();

/** That the composer takes a letter in less than a second: a page that answers, not one that freezes. */
async function composerAnswers(page: Page) {
  const box = composer(page);
  await expect(box).toBeVisible();
  const elapsed = await timed(async () => {
    await box.fill("Hello");
    await expect(box).toHaveValue("Hello");
  });
  expect(elapsed, "the composer took a letter").toBeLessThan(1_000);
}

/** The height of an element in lines of its own computed line height. */
const lines = (locator: Locator) =>
  locator.evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));

const sideways = (page: Page) =>
  page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth);

/** Unfolds what the fold holds in a part of the page, when it is folded. */
async function unfold(page: Page, within: Locator) {
  await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))));
  const more = within.getByRole("button", { name: "Read more" });
  if (await more.count()) await more.click();
}

/** Words separated by a space, in lines of a single break, without a blank at either end, nor a
 *  marker or a comma: plainPresentation and cardText leave it as it is. */
function wordsOf(length: number): string {
  const line = "word ".repeat(19) + "word\n"; // 100 characters
  const whole = line.repeat(Math.floor(length / 100));
  const rest = length - whole.length;
  // The last line, ended by a letter.
  if (rest === 0) return whole.slice(0, -1) + "s";
  return whole + "word ".repeat(20).slice(0, rest - 1) + "s";
}

test("the author's presentation comes first, and what the model reads is folded below it @desktop", async ({ page, request }) => {
  const convo = await conversationOf(request, {
    creator_notes: "A keeper of the **north light**.",
    description: "{{char}} counts the ships that never come back.",
    creator: "Mara Quill",
    character_version: "1.2",
  });
  await openPage(page, convo.character_id);

  const order = await page.evaluate(() =>
    [...document.querySelectorAll("main h2, main summary")].map((el) => el.textContent),
  );
  expect(order).toEqual(["From the author", "Opening", "What the model reads", "Your conversations"]);

  const frame = author(page).locator(".card-presentation");
  await expect(frame).toBeVisible();
  const heading = (await page.getByRole("heading", { level: 2, name: "From the author" }).boundingBox())!;
  const framed = (await frame.boundingBox())!;
  const next = (await page.getByRole("heading", { level: 2, name: "Opening" }).boundingBox())!;
  expect(framed.y).toBeGreaterThanOrEqual(heading.y + heading.height);
  expect(framed.y + framed.height).toBeLessThanOrEqual(next.y);

  // Folded: the description is not drawn until it is opened.
  await expect(page.getByText("Ilse counts the ships that never come back.")).toHaveCount(0);
  const details = await openModelReads(page);
  await expect(details.getByText("Ilse counts the ships that never come back.")).toBeVisible();

  // The creator and the version, under the name.
  const name = (await page.getByRole("heading", { level: 1, name: "Ilse" }).boundingBox())!;
  const by = page.getByText("by Mara Quill", { exact: true });
  const version = page.getByText("version 1.2", { exact: true });
  await expect(by).toBeVisible();
  await expect(version).toBeVisible();
  expect((await by.boundingBox())!.y).toBeGreaterThanOrEqual(name.y + name.height);
  expect((await version.boundingBox())!.y).toBeGreaterThan((await by.boundingBox())!.y);
});

test("the presentation is shown in the interface's language, and another can be chosen", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("evermind:locale", "fr"));
  const ilse = await card(request, {
    creator_notes: "The keeper of the north light.",
    creator_notes_multilingual: { fr: "Bonjour", ko: "안녕", "Supprimer la fiche": "Texte caché" },
  });
  await openPage(page, ilse.id);
  const region = page.getByRole("region", { name: "De la part de l'auteur" });
  const frame = region.locator(".card-presentation");
  await expect(frame).toContainText("Bonjour");

  const select = page.getByLabel("Langue de la présentation");
  await expect(select.locator("option:checked")).toHaveText("français");
  await expect(select.locator("option")).toHaveText(["Texte principal", "français", "coréen", "Autre version 4"]);
  await expect(select.locator("option", { hasText: "Supprimer la fiche" })).toHaveCount(0);

  await select.selectOption({ label: "Texte principal" });
  await expect(frame).toContainText("The keeper of the north light.");
  await select.selectOption({ label: "coréen" });
  await expect(frame).toContainText("안녕");
  await select.selectOption({ label: "Autre version 4" });
  await expect(frame).toContainText("Texte caché");
});

test("a long author name and many languages keep the page in reach on a phone", async ({ page, request }) => {
  const long = "a".repeat(10_000);
  const tags = [long, ...Array.from({ length: 999 }, (_, i) => `tag ${i}`)];
  const languages: Record<string, string> = {};
  for (let i = 0; i < 300; i++) {
    const key = String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
    languages[key] = `Text ${key}`;
  }
  const ilse = await card(request, {
    creator: long,
    character_version: long,
    tagline: long,
    tags,
    creator_notes: "The main text.",
    creator_notes_multilingual: languages,
  });
  await openPage(page, ilse.id);
  const screen = page.viewportSize()!.height;

  expect(await sideways(page), "the page scrolls sideways").toBeLessThanOrEqual(0);
  const by = page.getByText(/^by a+$/);
  const version = page.getByText(/^version a+$/);
  const tagline = page.locator("p.italic", { hasText: /^a+$/ });
  expect(await lines(by), "the author's line").toBeLessThanOrEqual(2.5);
  expect(await lines(version), "the version's line").toBeLessThanOrEqual(2.5);
  expect(await lines(tagline), "the tagline").toBeLessThanOrEqual(3.5);

  const chips = page.locator("main span.truncate[title]");
  await expect(chips).toHaveCount(8);
  const more = page.getByRole("button", { name: "Show the 992 other tags" });
  await expect(more).toHaveText("+992");

  // Before the tap: the real button and the presentation are in reach.
  const button = (await start(page).boundingBox())!;
  expect(button.y + (await page.evaluate(() => window.scrollY))).toBeLessThan(screen);
  const frame = author(page).locator(".card-presentation");
  const framed = (await frame.boundingBox())!;
  expect(framed.y + (await page.evaluate(() => window.scrollY))).toBeLessThan(2 * screen);

  // The page's own: the application's language picker, outside it, is a select too.
  const selects = page.locator("main select");
  await expect(selects).toHaveCount(1);
  await expect(selects.locator("option")).toHaveCount(201);

  // The cut: only 2 000 code points are drawn, the title as the text.
  const longChip = chips.first();
  expect(await longChip.evaluate((el) => [...el.textContent!].length)).toBe(2_000);
  expect(await longChip.evaluate((el) => [...el.getAttribute("title")!].length)).toBe(2_000);
  expect(await by.evaluate((el) => [...el.textContent!].length)).toBe(2_000 + "by ".length);
  expect(await version.evaluate((el) => [...el.textContent!].length)).toBe(2_000 + "version ".length);

  await more.click();
  await expect(chips).toHaveCount(1_000);
  expect(await sideways(page), "the page scrolls sideways with every tag shown").toBeLessThanOrEqual(0);
});

test("fifteen megabytes of greeting and presentation leave the page and the conversation answering", async ({ page, request }) => {
  test.setTimeout(240_000);
  const text = wordsOf(15 * 1_048_576);
  expect(text.trim()).toBe(text);
  const parts = Math.ceil(text.length / PLAIN_PART);
  expect(parts).toBe(79);
  const ilse = await card(request, { greeting: text, creator_notes: text, scenario: text });
  await openPage(page, ilse.id);

  await expect(opening(page).getByText(`Part 1 of ${parts}`)).toBeVisible({ timeout: 30_000 });
  await expect(author(page).getByText(`Part 1 of ${parts}`)).toBeVisible();

  const dialog = page.getByRole("dialog", { name: "Join Ilse" });
  const opened = await timed(async () => {
    await start(page).click();
    await expect(dialog).toBeVisible();
  });
  expect(opened, "the start window opened").toBeLessThan(1_000);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  const moved = await timed(async () => {
    await opening(page).getByRole("button", { name: "Next part" }).click();
    await expect(opening(page).getByText(`Part 2 of ${parts}`)).toBeVisible();
  });
  expect(moved, "the next part was shown").toBeLessThan(1_000);

  const convo = (await (await request.post(`${API}/api/conversations`, { data: { character_id: ilse.id } })).json()) as {
    id: string;
  };
  await page.goto(`/#/chat/${convo.id}`);
  const first = page.locator("[data-message-id]").first();
  await expect(first.getByText(`Part 1 of ${parts}`)).toBeVisible({ timeout: 30_000 });
  await composerAnswers(page);

  // The scene anchor of the panel, as side-panel.spec.ts opens it.
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel.getByText(`Part 1 of ${parts}`)).toBeVisible({ timeout: 30_000 });
  const typed = await timed(async () => {
    const box = panel.locator("textarea").first();
    await box.fill("Hello");
    await expect(box).toHaveValue("Hello");
  });
  expect(typed, "a field took a letter with the panel open").toBeLessThan(1_000);
  expect(thrown).toEqual([]);
});

test("a greeting too long to lay out is shown plainly, and the page answers", async ({ page, request }) => {
  const greeting = "*open _under [left ".repeat(Math.ceil((LAYOUT_BOUND + 1) / 19)).slice(0, LAYOUT_BOUND + 1);
  expect(greeting.length).toBe(LAYOUT_BOUND + 1);
  const ilse = await card(request, { greeting });
  await openPage(page, ilse.id);
  await expect(opening(page).getByText(en.characters.presentation.tooLong)).toBeVisible();
  await expect(opening(page).locator("em, strong")).toHaveCount(0);
  await start(page).click();
  await expect(page.getByRole("dialog", { name: "Join Ilse" })).toBeVisible();
  expect(thrown).toEqual([]);

  // What is measured is the text shown: a comment the card rules take out leaves it short.
  const short = await card(request, {
    card_rules: 2,
    greeting: "{{// " + "a".repeat(LAYOUT_BOUND) + "}}*hi*",
  });
  await openPage(page, short.id);
  await expect(opening(page).locator("em")).toHaveText("hi");
  await expect(opening(page).getByText(en.characters.presentation.tooLong)).toHaveCount(0);
  await expect(opening(page)).not.toContainText("aaaaaaaaaa");
});

test("a conversation opened with a greeting too long to lay out answers", async ({ page, request }) => {
  const greeting = "*open _under [left ".repeat(Math.ceil((LAYOUT_BOUND + 1) / 19)).slice(0, LAYOUT_BOUND + 1);
  const ilse = await card(request, { greeting });
  await openPage(page, ilse.id);
  await start(page).click();
  await page.getByRole("button", { name: "Enter the story" }).click();
  await expect(page).toHaveURL(/#\/chat\//);
  const first = page.locator("[data-message-id]").first();
  await expect(first).toContainText(greeting.slice(-30).trim());
  await expect(first.locator("em, strong")).toHaveCount(0);
  await composerAnswers(page);
  expect(thrown).toEqual([]);
});

test("a greeting of nested quotes leaves the page and its conversation answering", async ({ page, request }) => {
  const ilse = await card(request, { greeting: ">".repeat(5_000) + " x" });
  await openPage(page, ilse.id);
  await expect(opening(page).getByText(en.characters.presentation.tooDense)).toBeVisible();
  await expect(opening(page)).toContainText(">".repeat(100));
  await expect(opening(page).locator("blockquote")).toHaveCount(0);
  await start(page).click();
  await page.getByRole("button", { name: "Enter the story" }).click();
  await expect(page).toHaveURL(/#\/chat\//);
  const first = page.locator("[data-message-id]").first();
  await expect(first).toContainText(">>>>");
  await expect(first.locator("blockquote")).toHaveCount(0);
  await composerAnswers(page);
  expect(thrown).toEqual([]);

  // Under the bounds: laid out, its depth bounded.
  const convo = await conversationOf(request, { greeting: ">".repeat(300) + " x" });
  await page.goto(`/#/chat/${convo.id}`);
  const nested = page.locator("[data-message-id]").first();
  await expect(nested).toContainText("x");
  expect(await nested.locator("blockquote").count()).toBeLessThanOrEqual(64);
  expect(thrown).toEqual([]);
});

// A letter, then marks that climb (U+0301) and marks that sink (U+0316), stacked on it.
const STACKED = "a" + "\u0301".repeat(450) + "\u0316".repeat(450) + " b";

/** Settles once the page's animations have ended: a box measured while it rises is not where the
 *  picture, taken with them ended, shows it. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        // One that loops never ends.
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished),
    ),
  );

/** The band of 300 px above a box and the one below it, bounded to the page, as pictures. Each
 *  starts a pixel off the box: its edge falls between the phone's device pixels, and the row they
 *  share would show what the box itself paints. */
async function bandsAround(page: Page, box: Locator, mask: Locator[] = []): Promise<[Buffer, Buffer]> {
  await box.scrollIntoViewIfNeeded();
  await settled(page);
  const { top, bottom, width, height } = await box.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      top: Math.floor(rect.top + window.scrollY) - 1,
      bottom: Math.ceil(rect.bottom + window.scrollY) + 1,
      width: document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
    };
  });
  const from = Math.max(0, top - 300);
  // Animations ended: a bubble still rising would differ from one page to the other.
  const above = await page.screenshot({
    fullPage: true,
    animations: "disabled",
    clip: { x: 0, y: from, width, height: top - from },
    mask,
  });
  const below = await page.screenshot({
    fullPage: true,
    animations: "disabled",
    clip: { x: 0, y: bottom, width, height: Math.min(300, height - bottom) },
    mask,
  });
  return [above, below];
}

test("stacked accents paint nothing outside their box", async ({ page, request }) => {
  test.setTimeout(120_000);
  const pages: Array<[Buffer, Buffer]> = [];
  const conversations: Array<[Buffer, Buffer]> = [];
  for (const greeting of ["a b", STACKED]) {
    const convo = await conversationOf(request, { creator_notes: "A short presentation.", greeting });
    await page.goto(`/#/chat/${convo.id}`);
    const bubble = page.locator("[data-message-id]").first();
    await expect(bubble).toContainText("b");
    conversations.push(await bandsAround(page, bubble.locator(".rp-prose"), [page.locator("header"), page.locator("time")]));

    await openPage(page, convo.character_id);
    const box = opening(page).locator(".rp-prose");
    await expect(box).toContainText("b");
    await expect(opening(page).getByRole("button", { name: "Read more" })).toHaveCount(0);
    pages.push(await bandsAround(page, box));
  }
  expect(pages[0][0].equals(pages[1][0]), "the accents paint above the greeting on the page").toBe(true);
  expect(pages[0][1].equals(pages[1][1]), "the accents paint below the greeting on the page").toBe(true);
  expect(conversations[0][0].equals(conversations[1][0]), "the accents paint above the greeting's bubble").toBe(true);
  expect(conversations[0][1].equals(conversations[1][1]), "the accents paint below the greeting's bubble").toBe(true);

  const fields: Array<[Buffer, Buffer]> = [];
  for (const description of ["a b", STACKED]) {
    const ilse = await card(request, { description, greeting: "Hello." });
    await openPage(page, ilse.id);
    const details = await openModelReads(page);
    const text = field(details, "Description").locator(".card-presentation");
    await expect(text).toContainText("b");
    fields.push(await bandsAround(page, text));
  }
  expect(fields[0][0].equals(fields[1][0]), "the accents paint above the description").toBe(true);
  expect(fields[0][1].equals(fields[1][1]), "the accents paint below the description").toBe(true);

  const names: Array<[Buffer, Buffer]> = [];
  for (const name of ["a", "a" + "\u0301".repeat(100) + "\u0316".repeat(99)]) {
    const one = await card(request, { name });
    await openPage(page, one.id, name);
    const heading = page.getByRole("heading", { level: 1 });
    await settled(page);
    const { portrait, top, bottom, width } = await heading.evaluate((h1) => {
      const picture = document.querySelector("main .aspect-\\[3\\/4\\]")!.getBoundingClientRect();
      const rect = h1.getBoundingClientRect();
      // A pixel off each box, as in bandsAround.
      return {
        portrait: Math.ceil(picture.bottom + window.scrollY) + 1,
        top: Math.floor(rect.top + window.scrollY) - 1,
        bottom: Math.ceil(rect.bottom + window.scrollY) + 1,
        width: document.documentElement.clientWidth,
      };
    });
    names.push([
      await page.screenshot({ fullPage: true, animations: "disabled", clip: { x: 0, y: portrait, width, height: top - portrait } }),
      await page.screenshot({ fullPage: true, animations: "disabled", clip: { x: 0, y: bottom, width, height: 300 } }),
    ]);
  }
  expect(names[0][0].equals(names[1][0]), "the accents paint above the name").toBe(true);
  expect(names[0][1].equals(names[1][1]), "the accents paint below the name").toBe(true);
});

test("names that would make the text too long leave the markers as written", async ({ page, request }) => {
  const name = "Ilse" + "a".repeat(196);
  const ilse = await card(request, { name, card_rules: 2, creator_notes: "<BOT>".repeat(80_000) });
  await openPage(page, ilse.id, name);
  await expect(author(page).locator(".card-presentation")).toContainText("<BOT><BOT><BOT>");
  await start(page).click();
  await expect(page.getByRole("dialog", { name: `Join ${name}` })).toBeVisible();
  expect(thrown).toEqual([]);
});

test("the presentation is a region of its own for reading aids", async ({ page, request }) => {
  const ilse = await card(request, { creator_notes: "## What the model reads\n\nShe never says." });
  await openPage(page, ilse.id);
  const region = author(page);
  await expect(region.locator(".card-presentation")).toBeVisible();
  await expect(region.getByRole("heading", { level: 4, name: "What the model reads" })).toBeVisible();
  await expect(region.locator("summary")).toHaveCount(0);
  await expect(page.locator("summary", { hasText: "What the model reads" })).toHaveCount(1);
});

test("what the model reads puts in the default rules and counts only active lore", async ({ page, request }) => {
  const entry = (content: string, enabled = true) => ({ keys: ["lamp"], content, enabled });
  const ilse = await card(request, {
    system_prompt: "{{original}}\nStay in {{char}}'s voice.",
    lore_entries: [entry("One."), entry("Two."), entry("Three.", false)],
  });
  await openPage(page, ilse.id);
  let details = await openModelReads(page);
  const prompt = field(details, "Custom system prompt");
  await expect(prompt).toContainText("You are Ilse.");
  await expect(prompt).toContainText("Stay in Ilse's voice.");
  await expect(prompt).not.toContainText("{{original}}");
  expect(await prompt.evaluate((el) => el.lastElementChild!.textContent!.trimStart())).toMatch(/^ROLEPLAY RULES:/);
  await expect(details.getByText("Lorebook: 2 entries", { exact: true })).toBeVisible();

  const newRules = await card(request, { card_rules: 2, post_history_instructions: "{{original}} Keep it short." });
  await openPage(page, newRules.id);
  details = await openModelReads(page);
  const last = field(details, "End-of-context instructions");
  await expect(last).toContainText("Stay in character as Ilse. Write only Ilse's next turn. Keep it short.");
  await expect(last).not.toContainText("{{original}}");

  const oldRules = await card(request, { card_rules: 1, post_history_instructions: "{{original}} Keep it short." });
  await openPage(page, oldRules.id);
  details = await openModelReads(page);
  await expect(field(details, "End-of-context instructions")).toContainText("{{original}} Keep it short.");

  const blank = await card(request, {
    card_rules: 2,
    system_prompt: "{{// only a note}}",
    post_history_instructions: "{{// x}}",
    description: "A keeper.",
  });
  await openPage(page, blank.id);
  details = await openModelReads(page);
  await expect(field(details, "Description")).toContainText("A keeper.");
  await expect(details.getByRole("heading", { name: "Custom system prompt" })).toHaveCount(0);
  await expect(details.getByRole("heading", { name: "End-of-context instructions" })).toHaveCount(0);
});

test("what the model reads of a card on the old rules is shown as written", async ({ page, request }) => {
  const description = "{{// x}} <USER> meets {{char}} at {{random:dawn,dusk}}";
  const oldRules = await card(request, { description });
  await openPage(page, oldRules.id);
  let details = await openModelReads(page);
  await expect(field(details, "Description")).toContainText("{{// x}} <USER> meets Ilse at {{random:dawn,dusk}}");

  const newRules = await card(request, { card_rules: 2, description });
  await openPage(page, newRules.id);
  details = await openModelReads(page);
  await expect(field(details, "Description")).toContainText("you meets Ilse at dawn / dusk");

  for (const [depth, line] of [
    [1, "Character's note, placed before the last message"],
    [0, "Character's note, placed after the last message"],
  ] as const) {
    const noted = await card(request, { card_rules: 2, character_note: "Mind the lamp.", character_note_depth: depth });
    await openPage(page, noted.id);
    details = await openModelReads(page);
    await expect(field(details, line)).toContainText("Mind the lamp.");
  }

  const lore = await card(request, { lore_entries: [{ keys: ["lamp"], content: "The lamp." }] });
  await openPage(page, lore.id);
  details = await openModelReads(page);
  await expect(details.getByText("Lorebook: 1 entry", { exact: true })).toBeVisible();
});

test("the definition is laid out as Markdown alone, and nothing of it is hidden", async ({ page, request }) => {
  await watchPolicy(page);
  const description =
    "# Titre\n\n**gras** <img src=x onerror=1> <!-- caché --> [lien](https://example.com) " +
    "![image](https://pictures.example/x.png)\n\n<script>alert(1)</script>\n\n" +
    '**bold** <img src="https://pictures.example/d.png"> <script>window.__hit=1</script>\n\n' +
    "&#x202E;x&#8203;&lt;b&gt;";
  const ilse = await card(request, { description });
  await openPage(page, ilse.id);
  const details = await openModelReads(page);
  const text = field(details, "Description");
  await expect(text.locator(".card-presentation")).toBeVisible();
  await expect(text.getByRole("heading", { level: 4, name: "Titre" })).toBeVisible();
  await expect(text.locator("strong", { hasText: "gras" })).toBeVisible();
  await expect(text.locator("strong", { hasText: "bold" })).toBeVisible();
  for (const written of [
    "<img src=x onerror=1>",
    "<!-- caché -->",
    "[lien](https://example.com)",
    "![image](https://pictures.example/x.png)",
    "<script>alert(1)</script>",
    '<img src="https://pictures.example/d.png">',
    "<script>window.__hit=1</script>",
    // Character references as the model reads them: decoded, one would hide a space, another turn
    // the line backwards on screen, the last draw a tag.
    "&#x202E;x&#8203;&lt;b&gt;",
  ])
    await expect(text).toContainText(written);
  await expect(details.locator("img, a, script")).toHaveCount(0);
  await expect(text.locator("b")).toHaveCount(0);

  // As written: the text word for word, and nothing laid out.
  await details.getByRole("button", { name: "As written" }).click();
  await expect(details.getByRole("button", { name: "As written" })).toHaveAttribute("aria-pressed", "true");
  await expect(text.locator("p")).toHaveText(description, { useInnerText: false });
  expect(await text.locator("p").evaluate((el) => el.textContent)).toBe(description);
  await expect(text.locator("strong")).toHaveCount(0);

  await details.getByRole("button", { name: "Laid out" }).click();
  await expect(text.locator("strong", { hasText: "gras" })).toBeVisible();

  expect(asked.map((r) => r.url()), "a site of the card was contacted").toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __hit?: number }).__hit)).toBeUndefined();
  expect(await policyViolations(page)).toEqual([]);
});

test("a long definition written under Markdown headings is laid out section by section", async ({ page, request }) => {
  // The shape of a card brought on 14/11, written here: 3 parts, 14 sections, 38 subsections.
  const prose = "She keeps the lamp lit through every storm, and counts the ships that come home. ";
  const subsections = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2];
  const sectionsOfPart = [5, 5, 4];
  let text = "";
  let s = 0;
  for (let p = 0; p < 3; p++) {
    text += `# Part ${p + 1}\n\n${prose.repeat(3)}\n\n`;
    for (let k = 0; k < sectionsOfPart[p]; k++, s++) {
      text += `## Section ${s + 1}\n\n${prose.repeat(3)}\n\n`;
      for (let u = 0; u < subsections[s]; u++) text += `### Detail ${s + 1}.${u + 1}\n\n${prose.repeat(2)}\n\n`;
    }
  }
  text += "word ".repeat(Math.ceil((14_000 - text.length) / 5)).slice(0, Math.max(0, 14_000 - text.length - 1)) + ".";
  expect(text.length).toBe(14_000);
  const ilse = await card(request, { description: text });
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, ilse.id);
  const details = await openModelReads(page);
  const laid = field(details, "Description").locator(".card-presentation");
  await expect(laid.locator("h4, h5, h6")).toHaveCount(55);
  expect(await sideways(page), "the page scrolls sideways").toBeLessThanOrEqual(0);

  const pressed = await timed(async () => {
    await details.getByRole("button", { name: "As written" }).click();
    await expect(details.getByRole("button", { name: "As written" })).toHaveAttribute("aria-pressed", "true");
  });
  expect(pressed, "the switch took a tap").toBeLessThan(1_000);
});

test("starring a card keeps its lorebook count", async ({ page, request }) => {
  const entry = (content: string) => ({ keys: ["lamp"], content });
  const ilse = await card(request, { lore_entries: [entry("One."), entry("Two.")] });
  await openPage(page, ilse.id);
  await page.getByRole("button", { name: "Add to favorites" }).click();
  await expect(page.getByRole("button", { name: "Favorited" })).toBeVisible();
  const details = await openModelReads(page);
  await expect(details.getByText("Lorebook: 2 entries", { exact: true })).toBeVisible();
  expect(thrown).toEqual([]);
});

test("the old rules line stays in the header", async ({ page, request }) => {
  const ilse = await card(request, { card_rules: 1, creator_notes: "A keeper of the light." });
  await openPage(page, ilse.id);
  const line = page.getByRole("link", { name: en.characters.detail.rereadable });
  await expect(line).toBeVisible();
  const region = (await author(page).boundingBox())!;
  expect((await line.boundingBox())!.y).toBeLessThan(region.y);
  await line.click();
  await expect(page).toHaveURL(new RegExp(`#/characters/${ilse.id}/edit$`));
});

test("the whole greeting is shown, line breaks and all, with its variants", async ({ page, request }) => {
  const before = "word ".repeat(80).slice(0, 399);
  const first = before + "🌊" + " the tide".repeat(40);
  const second = "lamp ".repeat(Math.ceil((1_200 - first.length - 2) / 5)).slice(0, 1_200 - first.length - 2 - 8) + "lastword";
  const greeting = first + "\n\n" + second;
  expect(greeting.length).toBe(1_200);
  expect(greeting.codePointAt(399)).toBe(0x1f30a);
  const ilse = await card(request, { greeting });
  await openPage(page, ilse.id);
  await unfold(page, opening(page));
  await expect(opening(page).getByText(/lastword$/)).toBeVisible();
  await expect(opening(page).locator(".rp-prose p")).toHaveCount(2);
  await expect(opening(page)).toContainText("🌊");

  const three = await card(request, { greeting: "The first.", alternate_greetings: ["The second.", "The third."] });
  await openPage(page, three.id);
  await expect(opening(page).getByText("Opening 1 of 3")).toBeVisible();
  await expect(opening(page).locator(".rp-prose")).toHaveText("The first.");
  await opening(page).getByRole("button", { name: "Next opening" }).click();
  await expect(opening(page).locator(".rp-prose")).toHaveText("The second.");
  await opening(page).getByRole("button", { name: "Previous opening" }).click();
  await opening(page).getByRole("button", { name: "Previous opening" }).click();
  await expect(opening(page).locator(".rp-prose")).toHaveText("The third.");
});

test("a card made here shows what it has, and nothing empty", async ({ page, request }) => {
  const bare = await card(request, { greeting: "", description: "" });
  await openPage(page, bare.id);
  await expect(page.getByRole("heading", { level: 2, name: "From the author" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Opening" })).toHaveCount(0);
  await expect(page.locator("summary", { hasText: "What the model reads" })).toHaveCount(0);

  const commented = await card(request, {
    card_rules: 2,
    greeting: "{{// for SillyTavern only}}",
    alternate_greetings: ["A", "B"],
  });
  await openPage(page, commented.id);
  await expect(opening(page).getByText("Opening 1 of 2")).toBeVisible();
  await expect(opening(page).locator(".rp-prose")).toHaveText("A");
  await opening(page).getByRole("button", { name: "Next opening" }).click();
  await expect(opening(page).locator(".rp-prose")).toHaveText("B");
  for (const box of await page.locator(".rp-prose").all()) expect((await box.textContent())!.trim()).not.toBe("");

  const alone = await card(request, { card_rules: 2, greeting: "{{// for SillyTavern only}}" });
  await openPage(page, alone.id);
  await expect(page.getByRole("heading", { level: 2, name: "Opening" })).toHaveCount(0);
});

test("the markers of a card read as words", async ({ page, request }) => {
  const ilse = await card(request, { tagline: "{{random:dawn,dusk}} at <BOT>'s door{{// x}}" });
  await openPage(page, ilse.id);
  await expect(page.getByText("dawn / dusk at Ilse's door", { exact: true })).toBeVisible();
});

test("a nickname is the name the markers read, on the tile and the page @desktop", async ({ page, request }) => {
  const ilse = await card(request, { card_rules: 2, name: "Ilse Varga", nickname: "Ilse", tagline: "<BOT>'s door" });
  // The tile shows its tagline from the width of a desktop on.
  if (page.viewportSize()!.width >= 640) {
    await page.goto("/#/");
    await expect(page.getByText("Ilse's door", { exact: true }).first()).toBeVisible();
  }
  await openPage(page, ilse.id, "Ilse Varga");
  await expect(page.locator("main").getByText("Ilse's door", { exact: true })).toBeVisible();
});

test("the controls of the page can be reached on a phone", async ({ page, request }) => {
  const long = "She keeps the lamp lit through every storm.\n\n".repeat(60);
  const ilse = await card(request, {
    creator_notes: long,
    creator_notes_multilingual: { fr: "Bonjour" },
    greeting: long,
    alternate_greetings: ["The second."],
  });
  await openPage(page, ilse.id);
  await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))));
  const controls = [
    page.getByLabel("Language of the presentation"),
    opening(page).getByRole("button", { name: "Previous opening" }),
    opening(page).getByRole("button", { name: "Next opening" }),
    author(page).getByRole("button", { name: "Read more" }),
    opening(page).getByRole("button", { name: "Read more" }),
    page.locator("summary", { hasText: "What the model reads" }),
  ];
  for (const control of controls) {
    await expect(control).toBeVisible();
    expect((await control.boundingBox())!.height, await control.evaluate((el) => el.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(43.5);
  }
});
