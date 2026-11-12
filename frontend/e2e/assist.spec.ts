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

/** How long to wait for a card to end, by its own pace rather than the suite's ten seconds: the
 *  stand-in model's reasoning and writing together come near those ten seconds when the whole
 *  suite loads the machine, and a card that ends late still ends. */
const CARD = { timeout: 30_000 };

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
  await expect(nameField(page)).toHaveValue(NAME, CARD);
  await expect(taglineField(page)).toHaveValue(TAGLINE, CARD);
  await expect(stop(page)).toHaveCount(0, CARD);
  await expect(brief(page)).toBeEnabled();
});

test("a card goes on being written while the page is away", async ({ page, request }) => {
  await ask(page, request, "A seller of maps MOCK_THINKS");
  await expect(stop(page)).toBeVisible();

  await page.reload();

  await expect(brief(page)).toHaveValue("A seller of maps MOCK_THINKS");
  await expect(brief(page)).toBeDisabled();
  await expect(stop(page)).toBeVisible();
  await expect(nameField(page)).toHaveValue(NAME, CARD);
  await expect(stop(page)).toHaveCount(0, CARD);
  const found = await page.evaluate(() => localStorage.getItem("evermind:assist:new"));
  expect(found, "the job was still remembered after its end").toBeNull();
});

test("a card cut short keeps what was written and says what is missing", async ({ page, request }) => {
  await ask(page, request, "A seller of maps MOCK_CUT");

  await expect(nameField(page)).toHaveValue(NAME, CARD);
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

  await expect(stop(page)).toHaveCount(0, CARD);
  await expect(nameField(page)).toHaveValue(NAME, CARD);
  await expect(said(page)).toContainText("Stopped before the end");
  expect(await page.evaluate(() => localStorage.getItem("evermind:assist:new"))).toBeNull();
});

test("what is typed while the card is written is kept", async ({ page, request }) => {
  await ask(page, request, "A seller of maps MOCK_THINKS");
  await expect(stop(page)).toBeVisible();

  await nameField(page).fill("Typed meanwhile");

  await expect(taglineField(page)).toHaveValue(TAGLINE, CARD);
  await expect(stop(page)).toHaveCount(0, CARD);
  await expect(nameField(page)).toHaveValue("Typed meanwhile");
});

test("a model that only thinks is said so", async ({ page, request }) => {
  await ask(page, request, "A seller of maps MOCK_ONLY_THINKS");

  await expect(page.getByText(/The model is thinking/)).toBeVisible();
  await expect(said(page)).toContainText("spent its whole answer thinking", CARD);
  await expect(stop(page)).toHaveCount(0, CARD);
  await expect(nameField(page)).toHaveValue("");
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
