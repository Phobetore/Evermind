import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter } from "./fixtures";

/** What a card says beyond its text, in the lorebook and in the character's note: shown, changed
 *  only when someone changes it, and kept through a save made elsewhere in the form. */

const HOURS = "The harbour freezes in winter.";

/** An entry whose every setting is away from its default, as a community card writes them. */
const SET_APART = {
  keys: ["harbour"], content: HOURS, enabled: true, origin: 0, comment: "The frozen quay",
  constant: true, selective: true, secondary_keys: ["lamp"], selective_logic: 2,
  insertion_order: 7, position: 4, depth: 3, role: "user",
  whole_words: false, exclude_recursion: true, prevent_recursion: true,
};

const made: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`${API}/api/characters/${id}`);
});

/** A card on the rules of the cards of the community, which is what a card the interface makes is. */
async function seed(request: APIRequestContext, fields: Record<string, unknown> = {}) {
  const card = await makeCharacter(request, { card_rules: 2, lore_entries: [SET_APART], ...fields });
  made.push(card.id);
  return card as { id: string };
}

async function read(request: APIRequestContext, id: string) {
  return (await request.get(`${API}/api/characters/${id}`)).json();
}

/** An entry without what a save makes anew: the lorebook is written whole, and its rows get new ids and dates. */
const settingsOf = (row: Record<string, unknown>) => {
  const { id, created_at, updated_at, ...rest } = { ...row };
  void id; void created_at; void updated_at;
  return rest;
};

/** The entry, by its first key. The id only tells entries apart in the form. */
const entry = (page: Page, key: string) =>
  page.locator(".rounded-lg", { has: page.getByText(key, { exact: true }) });

/** Opens the settings of an entry and gives the panel, which is only what it holds. */
const openSettings = async (page: Page, key = "harbour") => {
  await entry(page, key).getByRole("button", { name: "Settings", exact: true }).click();
  return entry(page, key).getByRole("group", { name: "Settings" });
};

const save = async (page: Page, id: string) => {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/characters/${id}$`));
};

test("every setting of an entry survives a save made elsewhere in the form", async ({ page, request }) => {
  const card = await seed(request);
  const before = settingsOf((await read(request, card.id)).lore_entries[0]);
  expect(before, "the seed did not keep the settings").toMatchObject(SET_APART);

  await page.goto(`/#/characters/${card.id}/edit`);
  await page.getByRole("textbox", { name: /^Description/ }).fill("Changed elsewhere in the form.");
  await save(page, card.id);

  const after = await read(request, card.id);
  expect(after.description).toBe("Changed elsewhere in the form.");
  expect(after.lore_entries).toHaveLength(1);
  expect(settingsOf(after.lore_entries[0])).toEqual(before);
});

test("a setting changed in the form is the one saved", async ({ page, request }) => {
  const card = await seed(request, {
    lore_entries: [{ keys: ["harbour"], content: HOURS }],
  });
  await page.goto(`/#/characters/${card.id}/edit`);
  const panel = await openSettings(page);
  await panel.getByLabel("Always active").check();
  await panel.getByLabel(/^Place/).selectOption({ label: "At a depth" });
  await panel.getByLabel(/^Depth/).fill("2");
  await save(page, card.id);

  const [saved] = (await read(request, card.id)).lore_entries;
  expect(saved).toMatchObject({ constant: true, position: 4, depth: 2, content: HOURS });
});

test("a place SillyTavern has and Evermind does not is kept as it was", async ({ page, request }) => {
  const card = await seed(request, {
    lore_entries: [{ keys: ["harbour"], content: HOURS, position: 5 }],
  });
  await page.goto(`/#/characters/${card.id}/edit`);
  const panel = await openSettings(page);
  await expect(panel.getByLabel(/^Place/)).toHaveValue("5");
  await expect(panel.getByRole("option", { name: /Another SillyTavern place \(5\)/ })).toHaveCount(1);
  await page.getByRole("textbox", { name: /^Description/ }).fill("Touched.");
  await save(page, card.id);

  expect((await read(request, card.id)).lore_entries[0].position).toBe(5);
});

test("the character's note and nickname are saved", async ({ page, request }) => {
  const card = await seed(request, {
    lore_entries: [], creator_notes_multilingual: { fr: "Un phare." },
  });
  await page.goto(`/#/characters/${card.id}/edit`);
  await page.getByRole("button", { name: "Advanced settings" }).click();
  await page.getByLabel("Nickname").fill("Vee");
  await page.getByLabel("Character's note").fill("She never sits with her back to the door.");
  await page.getByLabel("Note depth").fill("6");
  await page.getByLabel("Note role").selectOption({ label: "Person" });
  // One text a language the card has, named by the language.
  await page.getByRole("textbox", { name: "fr", exact: true }).fill("Un phare, une femme.");
  await save(page, card.id);

  expect(await read(request, card.id)).toMatchObject({
    nickname: "Vee",
    character_note: "She never sits with her back to the door.",
    character_note_depth: 6,
    character_note_role: "user",
    creator_notes_multilingual: { fr: "Un phare, une femme." },
  });
});

test("a card on the old rules shows none of this", { tag: "@desktop" }, async ({ page, request }) => {
  const card = await seed(request, { card_rules: 1 });
  await page.goto(`/#/characters/${card.id}/edit`);
  await expect(entry(page, "harbour")).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Title")).toHaveCount(0);
  await page.getByRole("button", { name: "Advanced settings" }).click();
  await expect(page.getByLabel("Custom system prompt")).toBeVisible();
  await expect(page.getByLabel("Nickname")).toHaveCount(0);
  await expect(page.getByLabel("Character's note")).toHaveCount(0);

  // What it holds is sent back as it came.
  const before = await read(request, card.id);
  await page.getByRole("textbox", { name: /^Description/ }).fill("Touched.");
  await save(page, card.id);
  const after = await read(request, card.id);
  expect(after.lore_entries.map(settingsOf)).toEqual(before.lore_entries.map(settingsOf));
  expect(after.card_rules).toBe(1);
});

test("the settings can be reached on a phone", async ({ page, request }) => {
  const card = await seed(request);
  await page.goto(`/#/characters/${card.id}/edit`);
  const panel = await openSettings(page);
  await expect(panel.getByLabel("Always active")).toBeVisible();

  const controls = [
    entry(page, "harbour").getByRole("button", { name: "Settings", exact: true }),
    panel.locator("select"),
    panel.locator("input[type=number]"),
    // The box around the line typed in is what is touched.
    panel.locator(".field", { has: page.locator("input:not([type])") }),
    panel.locator("label", { has: page.locator("input[type=checkbox]") }),
  ];
  let seen = 0;
  for (const control of controls) {
    for (const one of await control.filter({ visible: true }).all()) {
      const box = await one.boundingBox();
      expect(box, "a control of the panel has no box").not.toBeNull();
      expect(box!.height, `${await one.textContent()} is too low to hit with a thumb`).toBeGreaterThanOrEqual(43.5);
      seen++;
    }
  }
  // Four lines of switches, the logic, the place and its role, the order and the depth, and the keys.
  expect(seen).toBeGreaterThanOrEqual(10);
});
