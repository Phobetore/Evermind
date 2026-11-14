import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { cardPortrait, makeCharacter } from "./fixtures";

/** A card made before Evermind kept cards whole: it keeps the rules it had until its owner asks,
 *  and a re-reading adds what the import of the time left out without undoing what was changed. */

const NOTE = "Mirela never lies.";
const ALWAYS = "The sea is always loud around the lighthouse.";

/** The card its portrait carries: an entry the import of the time read, one always on that it did not, and a note. */
const CARD = {
  spec: "chara_card_v2", spec_version: "2.0",
  data: {
    name: "Mirela", description: "A lighthouse keeper.", first_mes: "The lamp is lit.",
    extensions: { depth_prompt: { prompt: NOTE, depth: 2, role: "system" }, other_app: { mood: "grey" } },
    character_book: {
      entries: [
        { keys: ["lamp"], content: "The lamp burns whale oil.", insertion_order: 10 },
        { keys: [], content: ALWAYS, constant: true },
      ],
    },
  },
};

const made: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`${API}/api/characters/${id}`);
});

/** The character the import of the time made of the card, on the old rules, its portrait the card's PNG. */
async function madeBefore(request: APIRequestContext, fields: Record<string, unknown> = {}, card: unknown = CARD) {
  const character = await makeCharacter(request, {
    name: "Mirela", tagline: "", description: "A lighthouse keeper.", greeting: "The lamp is lit.",
    lore_entries: [{ keys: ["lamp"], content: "The lamp burns whale oil." }],
    ...fields,
  });
  made.push(character.id);
  await request.post(`${API}/api/characters/${character.id}/avatar`, {
    multipart: { file: { name: "mirela.png", mimeType: "image/png", buffer: cardPortrait(card) } },
  });
  return character as { id: string };
}

async function read(request: APIRequestContext, id: string) {
  return (await request.get(`${API}/api/characters/${id}`)).json();
}

const BANNER = "This card was made before Evermind kept cards whole.";

async function save(page: Page, id: string) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/characters/${id}$`));
}

test("nothing changes until the person asks", async ({ page, request }) => {
  const { id } = await madeBefore(request);
  const before = await read(request, id);
  expect(before.card_rules).toBe(1);

  await page.goto(`/#/characters/${id}`);
  await page.getByRole("link", { name: "Can be re-read with the new rules" }).click();
  await expect(page.getByText(BANNER)).toBeVisible();
  // What a re-reading would bring is said before anything is done.
  await expect(page.getByText("Will be added:")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(new RegExp(`#/characters/${id}$`));

  expect(await read(request, id)).toEqual(before);
});

test("re-reading fills the form and the save keeps it", async ({ page, request }) => {
  const { id } = await madeBefore(request);
  await page.goto(`/#/characters/${id}/edit`);
  await page.getByRole("button", { name: "Re-read the card and switch to the new rules" }).click();
  await expect(page.getByText("Save to keep this change.")).toBeVisible();
  // Nothing is written by the click itself.
  expect((await read(request, id)).card_rules).toBe(1);
  await save(page, id);

  const after = await read(request, id);
  expect(after).toMatchObject({ card_rules: 2, character_note: NOTE, character_note_depth: 2, has_card: true });
  expect(after.lore_entries.map(({ content, origin, constant }: Record<string, unknown>) => ({ content, origin, constant }))).toEqual([
    { content: "The lamp burns whale oil.", origin: 0, constant: false },
    { content: ALWAYS, origin: 1, constant: true },
  ]);
  await page.goto(`/#/characters/${id}/edit`);
  await expect(page.getByRole("heading", { name: "Edit Mirela" })).toBeVisible();
  await expect(page.getByText(BANNER)).toBeHidden();
});

test("a description retouched before is kept", async ({ page, request }) => {
  const mine = "A keeper I wrote again myself.";
  const { id } = await madeBefore(request, { description: mine });
  await page.goto(`/#/characters/${id}/edit`);
  await expect(page.getByText("Will stay as you left it:")).toBeVisible();
  await page.getByRole("button", { name: "Re-read the card and switch to the new rules" }).click();
  await save(page, id);

  expect(await read(request, id)).toMatchObject({ description: mine, card_rules: 2, character_note: NOTE });
});

test("keeping the card only keeps the card", async ({ page, request }) => {
  const { id } = await madeBefore(request);
  await page.goto(`/#/characters/${id}/edit`);
  await page.getByRole("button", { name: "Keep only the original card for the export" }).click();
  await expect(page.getByText("Save to keep this change.")).toBeVisible();
  await save(page, id);

  const after = await read(request, id);
  expect(after).toMatchObject({ has_card: true, card_rules: 1 });
  expect(after.lore_entries.map(({ content }: { content: string }) => content)).toEqual(["The lamp burns whale oil."]);
  // The new rules are still offered, and keeping the card no longer is: it is kept.
  await page.goto(`/#/characters/${id}/edit`);
  await expect(page.getByText(BANNER)).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-read the card and switch to the new rules" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep only the original card for the export" })).toBeHidden();
});

test("a card with nothing to re-read can still change its rules", async ({ page, request }) => {
  const character = await makeCharacter(request, { name: "Nobody's Card" });
  made.push(character.id);
  await page.goto(`/#/characters/${character.id}/edit`);
  await expect(page.getByText(BANNER)).toBeVisible();
  await page.getByRole("button", { name: "Switch to the new rules" }).click();
  await save(page, character.id);

  expect(await read(request, character.id)).toMatchObject({ card_rules: 2, has_card: false });
});

test("keeping, then re-reading, leaves each entry its own settings", async ({ page, request }) => {
  const card = {
    spec: "chara_card_v2", spec_version: "2.0",
    data: {
      name: "Mirela", description: "A lighthouse keeper.", first_mes: "The lamp is lit.",
      character_book: { entries: [
        { keys: ["lamp"], content: "The lamp burns whale oil.", comment: "The lamp", extensions: { position: 4, depth: 2 } },
        { keys: ["boat"], content: "The boat is red.", selective: true, secondary_keys: ["sea"] },
        { keys: ["gull"], content: "A gull named Pell.", constant: true },
      ] },
    },
  };
  const { id } = await madeBefore(request, {
    lore_entries: card.data.character_book.entries.map(({ keys, content }) => ({ keys, content })),
  }, card);
  await page.goto(`/#/characters/${id}/edit`);
  await page.getByRole("button", { name: "Keep only the original card for the export" }).click();
  await save(page, id);

  // Its owner deletes the lamp and writes an entry of their own, as many entries as before.
  const kept = await read(request, id);
  const entries = kept.lore_entries.slice(1);
  await request.put(`${API}/api/characters/${id}`, {
    data: { lore_entries: [...entries, { keys: ["keeper"], content: "Made here." }] },
  });
  await page.goto(`/#/characters/${id}/edit`);
  await page.getByRole("button", { name: "Re-read the card and switch to the new rules" }).click();
  await save(page, id);

  const after = await read(request, id);
  expect(after.lore_entries.map(({ keys, origin, constant, selective, secondary_keys, position }: Record<string, unknown>) =>
    ({ keys, origin, constant, selective, secondary_keys, position }))).toEqual([
    { keys: ["boat"], origin: 1, constant: false, selective: true, secondary_keys: ["sea"], position: 1 },
    { keys: ["gull"], origin: 2, constant: true, selective: false, secondary_keys: [], position: 1 },
    { keys: ["keeper"], origin: null, constant: false, selective: false, secondary_keys: [], position: 1 },
  ]);
});

test("a card that could not be looked for can be looked for again", async ({ page, request }) => {
  const { id } = await madeBefore(request);
  let failed = false;
  // The first time the page asks for the portrait's bytes, the road fails.
  await page.route("**/api/media/**", (route) => {
    if (failed || route.request().resourceType() !== "fetch") return route.continue();
    failed = true;
    return route.abort("connectionfailed");
  });
  await page.goto(`/#/characters/${id}/edit`);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-read the card and switch to the new rules" })).toBeHidden();
  await page.getByRole("button", { name: "Look for the card again" }).click();
  await expect(page.getByRole("button", { name: "Re-read the card and switch to the new rules" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep only the original card for the export" })).toBeVisible();
});
