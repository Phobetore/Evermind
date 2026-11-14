import { expect, test, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter } from "./fixtures";

/**
 * The card assistant is a job the server owns (see scripts/mock_llm.py for the stand-in model's
 * markers): the page watches the card being written, and a page that goes away finds the job again.
 *
 * A marker is a word in the brief, which the stand-in model reads. A card at the suite's pace takes
 * a few seconds; MOCK_THINKS adds two seconds of reasoning first, which gives a test room to act
 * while the job runs. SLOWLY is for a test that needs a job still going when it looks and does not
 * wait for the end: it stops it.
 */

const NAME = "Nyra the Cartographer";
const TAGLINE = "She sells maps of places that do not exist yet.";

const brief = (page: Page) => page.getByPlaceholder(/^Describe the character you want/);
const generate = (page: Page) => page.getByRole("button", { name: "Generate the card" });
const stop = (page: Page) => page.getByRole("button", { name: "Stop", exact: true });
const nameField = (page: Page) => page.getByLabel("Name", { exact: true });
const taglineField = (page: Page) => page.getByLabel("Tagline");
const chips = (page: Page) => page.getByRole("list", { name: "Fields written" }).getByRole("listitem");
const done = (page: Page) => chips(page).filter({ hasText: /done$/ });
/** What the form says under the assistant block once the job has ended. */
const said = (page: Page) => page.locator("p.break-words").filter({ hasText: /Press Generate again|ran out of room|spent its whole answer/ });

async function ask(page: Page, request: Parameters<typeof makeCharacter>[0], words: string) {
  // The connection to the stand-in model is made along with a card, as the other specs do.
  await makeCharacter(request);
  await page.goto("/#/characters/new");
  await brief(page).fill(words);
  await generate(page).click();
}

// A job left running would go on writing into the tests that come next.
test.afterEach(async ({ page, request }) => {
  const kept = await page.evaluate(() => localStorage.getItem("evermind:assist:new")).catch(() => null);
  if (kept) await request.delete(`${API}/api/characters/assist/${JSON.parse(kept).id}`);
});

test("a card is written under the eyes of the person, and fills the form", { tag: "@desktop" }, async ({ page, request }) => {
  await ask(page, request, "A seller of maps");

  await expect(stop(page)).toBeVisible();
  await expect(brief(page)).toBeDisabled();
  await expect(done(page).first(), "no field turned done before the end").toBeVisible();
  await expect(nameField(page)).toHaveValue(NAME);
  await expect(taglineField(page)).toHaveValue(TAGLINE);
  await expect(stop(page)).toHaveCount(0);
  await expect(brief(page)).toBeEnabled();
});

test("a card goes on being written while the page is away", async ({ page, request }) => {
  await ask(page, request, "A seller of maps MOCK_THINKS");
  await expect(stop(page)).toBeVisible();

  await page.reload();

  await expect(brief(page)).toHaveValue("A seller of maps MOCK_THINKS");
  await expect(brief(page)).toBeDisabled();
  await expect(stop(page)).toBeVisible();
  await expect(nameField(page)).toHaveValue(NAME);
  await expect(stop(page)).toHaveCount(0);
  const found = await page.evaluate(() => localStorage.getItem("evermind:assist:new"));
  expect(found, "the job was still remembered after its end").toBeNull();
});

test("a card cut short keeps what was written and says what is missing", async ({ page, request }) => {
  await ask(page, request, "A seller of maps MOCK_CUT");

  await expect(nameField(page)).toHaveValue(NAME);
  await expect(page.getByLabel("First message")).toHaveValue(/There you are/);
  const sentence = said(page);
  await expect(sentence).toContainText("ran out of room");
  await expect(sentence).toContainText("Alternate openings");
  await expect(sentence).toContainText("Tags");
  await expect(sentence).not.toContainText("Tagline");
  await expect(sentence).toContainText("Press Generate again");
});

test("stopping keeps what was complete", async ({ page, request }) => {
  await ask(page, request, "A seller of maps SLOWLY");

  await expect(done(page).first()).toBeVisible();
  await stop(page).click();

  await expect(stop(page)).toHaveCount(0);
  await expect(nameField(page)).toHaveValue(NAME);
  await expect(said(page)).toContainText("Stopped before the end");
  expect(await page.evaluate(() => localStorage.getItem("evermind:assist:new"))).toBeNull();
});

test("what is typed while the card is written is kept", async ({ page, request }) => {
  await ask(page, request, "A seller of maps MOCK_THINKS");
  await expect(stop(page)).toBeVisible();

  await nameField(page).fill("Typed meanwhile");

  await expect(taglineField(page)).toHaveValue(TAGLINE);
  await expect(stop(page)).toHaveCount(0);
  await expect(nameField(page)).toHaveValue("Typed meanwhile");
});

test("a model that only thinks is said so", async ({ page, request }) => {
  await ask(page, request, "A seller of maps MOCK_ONLY_THINKS");

  await expect(page.getByText(/The model is thinking/)).toBeVisible();
  await expect(said(page)).toContainText("spent its whole answer thinking");
  await expect(stop(page)).toHaveCount(0);
  await expect(nameField(page)).toHaveValue("");
});

test("a tag typed again in another case is there once", async ({ page, request }) => {
  await makeCharacter(request);
  await page.goto("/#/characters/new");
  const box = page.getByPlaceholder("Add a tag, then Enter");
  await box.fill("Fantasy");
  await box.press("Enter");
  // The placeholder goes once there is a tag; the box keeps the focus, as for a person typing on.
  await page.keyboard.type(" fantasy ");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^Remove\s+fantasy$/i })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove Fantasy" })).toHaveCount(1);
});

test("a card that has tags keeps each of them once", async ({ page, request }) => {
  // Passes on the code before the fix too: the card's own tags replace the model's whole list, so
  // this path never doubled. It pins that it stays so. The stand-in model writes "fantasy" and
  // "mystery": the card's own spelling of the same tags.
  const card = await makeCharacter(request, { tags: ["Fantasy", " Mystery "] });
  await page.goto(`/#/characters/${card.id}/edit`);
  await brief(page).fill("A seller of maps");
  await generate(page).click();

  // The card ended: a field it had empty is filled, the ones it had are its own.
  await expect(page.getByLabel("Personality")).toHaveValue(/sly/);
  await expect(nameField(page)).toHaveValue("Vane");
  const tags = page.getByRole("button", { name: /^Remove\s+(fantasy|mystery)\s*$/i });
  await expect(tags).toHaveCount(2);
});

test("a brief of a hundred thousand characters is kept whole, and said too long for the model", async ({ page, request }, info) => {
  await makeCharacter(request);
  await page.goto("/#/characters/new");
  const text = "A seller of maps who draws tomorrow. ".repeat(2_800).slice(0, 100_000);

  let started = Date.now();
  await brief(page).fill(text);
  const pasted = Date.now() - started;
  started = Date.now();
  await brief(page).press("End");
  await brief(page).pressSequentially("!");
  const typed = Date.now() - started;
  info.annotations.push({ type: "timing", description: `pasted in ${pasted} ms, one key after it in ${typed} ms` });
  expect(pasted, "pasting froze the page").toBeLessThan(3_000);
  expect(typed, "a key pressed in a long brief froze the page").toBeLessThan(1_000);
  expect((await brief(page).inputValue()).length).toBe(100_001);

  await generate(page).click();
  // The stand-in model's connection holds 16384 tokens, which the brief alone outgrows.
  const refused = page.getByText(/too long for this model/);
  await expect(refused).toBeVisible();
  await expect(refused).toContainText("the connection holds 16,384");
  await expect(brief(page)).toBeEnabled();
});

test("the panel fits a narrow phone", async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await ask(page, request, "A seller of maps SLOWLY");

  await expect(done(page).first()).toBeVisible();
  const overflow = await page.evaluate(() => {
    const guilty = [...document.querySelectorAll("body *")]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.right > 321 && getComputedStyle(el).position !== "fixed";
      })
      .map((el) => el.tagName.toLowerCase() + "." + String(el.className).split(" ")[0]);
    return { page: document.documentElement.scrollWidth, guilty };
  });
  expect(overflow.guilty, `elements past the right edge: ${overflow.guilty}`).toEqual([]);
  expect(overflow.page).toBeLessThanOrEqual(320);
});
