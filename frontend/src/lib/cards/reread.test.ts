import { crc32 } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import { data, type CardCharacter } from "@/data";
import type { LibraryItem } from "@/types";
import { newLoreEntry } from "../loreEntry";
import { FIELDS, readCardJson } from "./read";
import { findOriginal, oldReading, rereadPlan, type FoundCard } from "./reread";

// A PNG of one pixel, without any card.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const base64 = (value: unknown) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** The PNG with a tEXt chunk for each card, before its end. */
function pngWith(...cards: [keyword: string, card: unknown][]) {
  const chunks = cards.map(([keyword, card]) => {
    const body = new TextEncoder().encode(`tEXt${keyword}\0${base64(card)}`);
    const chunk = new Uint8Array(body.length + 8);
    new DataView(chunk.buffer).setUint32(0, body.length - 4);
    chunk.set(body, 4);
    new DataView(chunk.buffer).setUint32(body.length + 4, crc32(body));
    return chunk;
  });
  return new File([PNG.subarray(0, -12), ...chunks, PNG.subarray(-12)], "portrait.png", { type: "image/png" });
}

const v2 = (fields: Record<string, unknown>) => ({ spec: "chara_card_v2", spec_version: "2.0", data: fields });
const v3 = (fields: Record<string, unknown>) => ({ spec: "chara_card_v3", spec_version: "3.0", data: fields });

/** The card found in a JSON file, as the library gives one: read now, and as the import of the time read it. */
const found = (card: unknown): FoundCard => ({ read: readCardJson(card, JSON.stringify(card), "json")!, old: oldReading(card)! });

/** The character the import of the time made of a card: its reading, its entries with no origin. */
function madeBefore(card: unknown): CardCharacter {
  const old = oldReading(card)!;
  return { ...old, lore_entries: old.lore_entries.map((entry) => ({ ...entry, origin: null })) };
}

/** A character as the page holds it, to look for its card. */
const looked = (character: CardCharacter, avatar_url: string | null = "api/media/face.png") =>
  ({ ...character, id: "c1", has_card: false, avatar_url });

const portraitIs = (file: File) => vi.spyOn(data, "file").mockResolvedValue(file);
const libraryIs = (items: LibraryItem[]) => vi.spyOn(data.library, "list").mockResolvedValue(items);

afterEach(() => {
  vi.restoreAllMocks();
});

const MIRELA = v2({
  name: "Mirela", description: "A lighthouse keeper.", personality: "Calm.", first_mes: "The lamp is lit.",
  system_prompt: "Write as Mirela.", post_history_instructions: "Stay in the lighthouse.",
  extensions: { depth_prompt: { prompt: "Mirela never lies.", depth: 2, role: "system" } },
  character_book: {
    entries: [
      { keys: ["lamp"], content: "The lamp burns whale oil.", comment: "The lamp", insertion_order: 5, extensions: { position: 4, depth: 2 } },
      { keys: ["boat"], content: "The boat is red.", selective: true, secondary_keys: ["sea"] },
      { keys: ["gull"], content: "A gull named Pell." },
    ],
  },
});

/** A book that says which entry is which by more than its rank: lamp with a comment and a place,
 *  one always on that the old import dropped, boat with a second key, gull switched off, and one
 *  with no text that nothing keeps. */
const BOOK = v2({
  name: "Mirela", description: "A lighthouse keeper.", first_mes: "The lamp is lit.",
  character_book: { entries: [
    { keys: ["lamp"], content: "The lamp burns whale oil.", comment: "The lamp", insertion_order: 5, extensions: { position: 4, depth: 2, other: 1 } },
    { keys: [], content: "The fog never lifts.", constant: true },
    { keys: ["boat"], content: "The boat is red.", selective: true, secondary_keys: ["sea"], extensions: { b: 1 } },
    { keys: ["gull"], content: "A gull named Pell.", enabled: false, extensions: { g: 1 } },
    { keys: ["fog"], content: "" },
  ] },
});

/** A PNG of RisuRealm: ccv3 with decorators, in another order than its chara copy without them. */
const TWO_CHUNKS = {
  ccv3: v3({
    name: "Mirela", description: "A lighthouse keeper.",
    character_book: { entries: [
      { keys: ["boat"], content: "@@activate\nThe boat is red.", constant: true, extensions: { position: 0 } },
      { keys: ["lamp"], content: "The lamp burns whale oil.", selective: true, secondary_keys: ["oil"], extensions: { position: 4, depth: 2 } },
      { keys: ["gull"], content: "A gull named Pell." },
    ] },
  }),
  chara: v2({
    name: "Mirela", description: "A lighthouse keeper.",
    character_book: { entries: [
      { keys: ["lamp"], content: "The lamp burns whale oil." },
      { keys: ["boat"], content: "The boat is red." },
      { keys: ["gull"], content: "A gull named Pell." },
      { keys: ["fog"], content: "" },
    ] },
  }),
};

/** A character once a plan is saved: the form with the plan in it, its card kept as the server keeps it. */
function saved(character: CardCharacter, plan: ReturnType<typeof rereadPlan>) {
  const after: CardCharacter = { ...character, ...plan.fields, lore_entries: plan.lore };
  vi.spyOn(data.characters, "card").mockResolvedValue(plan.card && { ...plan.card, read_at: "" });
  return { character: after, looked: { ...looked(after), has_card: Boolean(plan.card) } };
}

describe("re-reading a card", () => {
  test("a retouched field is left as it is and said so", () => {
    const plan = rereadPlan({ ...madeBefore(MIRELA), description: "Mine now." }, found(MIRELA), "reread");
    expect(plan.fields.description).toBeUndefined();
    expect(plan.untouched).toContain("description");
    expect(plan.added.flatMap((line) => line.names ?? [])).not.toContain("description");
  });

  test("a field emptied by its owner stays empty", () => {
    const current = { ...madeBefore(MIRELA), post_history_instructions: "", system_prompt: "" };
    const plan = rereadPlan(current, found(MIRELA), "reread");
    expect(plan.fields).not.toHaveProperty("post_history_instructions");
    expect(plan.fields).not.toHaveProperty("system_prompt");
    expect(plan.added.flatMap((line) => line.names ?? [])).not.toEqual(expect.arrayContaining(["post_history_instructions"]));
    expect(plan.added.flatMap((line) => line.names ?? [])).not.toEqual(expect.arrayContaining(["system_prompt"]));
    expect(plan.untouched).toEqual(expect.arrayContaining(["post_history_instructions", "system_prompt"]));
  });

  test("a field nobody touched takes the fuller reading", async () => {
    const full = v3({ name: "Mirela", description: "A lighthouse keeper, sixty years at the lamp.", first_mes: "The lamp is lit." });
    const poor = v2({ name: "Mirela", description: "A keeper.", first_mes: "The lamp is lit." });
    const before = madeBefore(poor);
    portraitIs(pngWith(["ccv3", full], ["chara", poor]));
    const card = await findOriginal(looked(before));
    expect(card).not.toBeNull();
    const plan = rereadPlan(before, card, "reread");
    expect(plan.fields.description).toBe("A lighthouse keeper, sixty years at the lamp.");
    expect(plan.added).toContainEqual({ key: "fields", names: ["description"] });
    expect(plan.fields.card_rules).toBe(2);
  });

  test("entries are matched by rank, and get the card's settings", () => {
    const current = madeBefore(MIRELA);
    current.lore_entries[0] = { ...current.lore_entries[0], keys: ["oil lamp"] };
    const plan = rereadPlan(current, found(MIRELA), "reread");
    expect(plan.lore.map((entry) => entry.origin)).toEqual([0, 1, 2]);
    expect(plan.lore[0]).toMatchObject({
      keys: ["oil lamp"], content: "The lamp burns whale oil.", comment: "The lamp", insertion_order: 5, position: 4, depth: 2,
    });
    expect(plan.lore[1]).toMatchObject({ keys: ["boat"], selective: true, secondary_keys: ["sea"] });
  });

  test("an edited entry keeps its origin", () => {
    const current = madeBefore(MIRELA);
    current.lore_entries[1] = { ...current.lore_entries[1], content: "The boat is blue now." };
    const plan = rereadPlan(current, found(MIRELA), "reread");
    expect(plan.lore).toHaveLength(3);
    expect(plan.lore[1]).toMatchObject({ origin: 1, keys: ["boat"], content: "The boat is blue now." });
  });

  test("an entry deleted before is not brought back", () => {
    const current = madeBefore(MIRELA);
    current.lore_entries.splice(1, 1);
    const plan = rereadPlan(current, found(MIRELA), "reread");
    expect(plan.lore.map(({ keys, origin }) => ({ keys, origin }))).toEqual([
      { keys: ["lamp"], origin: 0 }, { keys: ["gull"], origin: 2 },
    ]);
    expect(plan.added.filter((line) => line.key === "lore")).toEqual([]);
  });

  test("an always-on entry the old import dropped is added at the end", () => {
    const card = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [{ keys: ["lamp"], content: "Whale oil." }, { keys: [], content: "The sea is loud.", constant: true }] },
    });
    const current = madeBefore(card);
    expect(current.lore_entries).toHaveLength(1);
    const plan = rereadPlan(current, found(card), "reread");
    expect(plan.lore.map(({ content, origin, constant }) => ({ content, origin, constant }))).toEqual([
      { content: "Whale oil.", origin: 0, constant: false },
      { content: "The sea is loud.", origin: 1, constant: true },
    ]);
    expect(plan.added).toContainEqual({ key: "lore", count: 1 });
  });

  test("an entry made here stays as it is, with no origin", () => {
    const current = madeBefore(MIRELA);
    const mine = newLoreEntry(["keeper"], "Made here.");
    current.lore_entries.push(mine);
    const plan = rereadPlan(current, found(MIRELA), "reread");
    expect(plan.lore.map((entry) => entry.origin)).toEqual([0, 1, 2, null]);
    expect(plan.lore[3]).toEqual(mine);
  });

  test("two equal entries are matched one to one", () => {
    const card = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [{ keys: ["k", "j"], content: "Same." }, { keys: ["k", "j"], content: "Same." }, { keys: ["z"], content: "Z." }] },
    });
    const current = madeBefore(card);
    // The last one deleted, and the keys of the two others written in another order.
    current.lore_entries = current.lore_entries.slice(0, 2).map((entry) => ({ ...entry, keys: ["j", "k"] }));
    const plan = rereadPlan(current, found(card), "reread");
    expect(plan.lore.map((entry) => entry.origin)).toEqual([0, 1]);
    expect(plan.added.filter((line) => line.key === "lore")).toEqual([]);
  });

  test("a ccv3 card with decorators and a chara backfill without them adds nothing", async () => {
    const ccv3 = v3({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["boat"], content: "@@activate\nThe boat is red." },
        { keys: ["lamp"], content: "@@depth 2\r\n@@dont_activate\nThe lamp burns whale oil." },
        { keys: ["gull"], content: "A gull named Pell." },
      ] },
    });
    const chara = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["lamp"], content: "The lamp burns whale oil." },
        { keys: ["boat"], content: "The boat is red." },
        { keys: ["gull"], content: "A gull named Pell." },
        { keys: ["fog"], content: "" },
      ] },
    });
    const before = madeBefore(chara);
    portraitIs(pngWith(["ccv3", ccv3], ["chara", chara]));
    const plan = rereadPlan(before, await findOriginal(looked(before)), "reread");
    expect(plan.lore.map(({ keys, origin }) => ({ keys, origin }))).toEqual([
      { keys: ["lamp"], origin: 1 }, { keys: ["boat"], origin: 0 }, { keys: ["gull"], origin: 2 },
    ]);
    expect(plan.added.filter((line) => line.key === "lore")).toEqual([]);
  });

  test("a portrait carrying another card is not taken", async () => {
    portraitIs(pngWith(["chara", v2({ name: "Orla", description: "A fisher.", first_mes: "Nets." })]));
    libraryIs([]);
    expect(await findOriginal(looked(madeBefore(MIRELA)))).toBeNull();
  });

  test("a library card of the same name but another text is not taken", async () => {
    libraryIs([{ filename: "mirela.json", has_avatar: false, card: v2({ name: "Mirela", description: "A smuggler.", first_mes: "Hush." }) }]);
    expect(await findOriginal(looked(madeBefore(MIRELA), null))).toBeNull();
  });

  test("keeping the card changes nothing the old rules read", () => {
    const card = v2({
      name: "Mirela", description: "A lighthouse keeper.", tags: ["sea", "Sea", " lamp "],
      extensions: { depth_prompt: { prompt: "Mirela never lies.", depth: 2, role: "system" } },
      character_book: { entries: [
        { keys: [" lamp "], content: "Whale oil.", insertion_order: 7, extensions: { position: 0 } },
        { keys: [], content: "The sea is loud.", constant: true },
        { keys: ["boat"], content: "Red.", enabled: false },
      ] },
    });
    const current = madeBefore(card);
    current.lore_entries[1] = { ...current.lore_entries[1], content: "Blue, now." };
    const plan = rereadPlan(current, found(card), "keep");
    const old = oldReading(card)!;
    const kept = { ...current, ...plan.fields, lore_entries: plan.lore };
    const ruled = (character: CardCharacter) => ({
      ...Object.fromEntries(Object.entries(character).filter(([key]) =>
        !["nickname", "character_note", "character_note_depth", "character_note_role", "creator_notes_multilingual", "card_rules", "lore_entries"].includes(key))),
      lore: character.lore_entries.map(({ keys, content, enabled }) => ({ keys, content, enabled })),
    });
    expect(ruled(kept)).toEqual(ruled(current));
    expect(kept.card_rules).toBe(1);
    expect(kept.character_note).toBe("Mirela never lies.");
    expect(plan.lore.map((entry) => entry.origin)).toEqual([0, 2]);
    expect(plan.lore[0]).toMatchObject({ insertion_order: 7, position: 0 });
    const read = plan.card!.read;
    for (const field of ["kind", "tagline", ...Object.values(FIELDS), "alternate_greetings", "tags"] as const) {
      expect(read[field], field).toEqual(old[field]);
    }
    expect(read.lore_entries.map(({ keys, content, enabled, origin }) => ({ keys, content, enabled, origin }))).toEqual(
      old.lore_entries.map(({ keys, content, enabled, origin }) => ({ keys, content, enabled, origin })),
    );
  });

  test("one entry deleted and one written here, as many as before, hand nothing to each other", () => {
    const current = madeBefore(BOOK);
    // boat deleted, an entry written here at the end: three entries, as many as the old reading.
    current.lore_entries = [current.lore_entries[0], current.lore_entries[2], newLoreEntry(["keeper"], "Made here.")];
    expect(current.lore_entries).toHaveLength(oldReading(BOOK)!.lore_entries.length);
    const plan = rereadPlan(current, found(BOOK), "reread");
    const [lamp, gull, keeper] = plan.lore.filter((entry) => entry.content !== "The fog never lifts.");
    expect(gull).toMatchObject({ keys: ["gull"], origin: 3, selective: false, secondary_keys: [] });
    expect(keeper).toMatchObject({ keys: ["keeper"], origin: null, constant: false });
    expect(lamp).toMatchObject({ origin: 0, comment: "The lamp" });
  });

  test("one entry retouched beside one deleted keeps its origin", () => {
    const current = madeBefore(BOOK);
    current.lore_entries = [{ ...current.lore_entries[0], content: "The lamp burns seal oil now." }, current.lore_entries[2]];
    const plan = rereadPlan(current, found(BOOK), "reread");
    expect(plan.lore[0]).toMatchObject({
      origin: 0, content: "The lamp burns seal oil now.", comment: "The lamp", insertion_order: 5, position: 4, depth: 2,
    });
    expect(plan.lore.find((entry) => entry.keys[0] === "gull")).toMatchObject({ origin: 3, enabled: false });
  });

  test("keeping the card, then re-reading it, leaves each entry its own settings", async () => {
    const before = madeBefore(TWO_CHUNKS.chara);
    portraitIs(pngWith(["ccv3", TWO_CHUNKS.ccv3], ["chara", TWO_CHUNKS.chara]));
    const kept = saved(before, rereadPlan(before, await findOriginal(looked(before)), "keep"));
    const plan = rereadPlan(kept.character, await findOriginal(kept.looked), "reread");
    expect(plan.lore.map(({ keys, content, origin, constant, selective, secondary_keys, position }) =>
      ({ keys, content, origin, constant, selective, secondary_keys, position }))).toEqual([
      { keys: ["lamp"], content: "The lamp burns whale oil.", origin: 1, constant: false, selective: true, secondary_keys: ["oil"], position: 4 },
      { keys: ["boat"], content: "@@activate\nThe boat is red.", origin: 0, constant: true, selective: false, secondary_keys: [], position: 0 },
      { keys: ["gull"], content: "A gull named Pell.", origin: 2, constant: false, selective: false, secondary_keys: [], position: 1 },
    ]);
  });

  test("keeping the card, deleting an entry and writing one, then re-reading, pairs each entry with its own", async () => {
    const card = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["lamp"], content: "The lamp burns whale oil.", comment: "The lamp", insertion_order: 5, extensions: { position: 4, depth: 2 } },
        { keys: ["boat"], content: "The boat is red.", selective: true, secondary_keys: ["sea"] },
        { keys: ["gull"], content: "A gull named Pell.", constant: true },
      ] },
    });
    const before = madeBefore(card);
    portraitIs(pngWith(["chara", card]));
    const kept = saved(before, rereadPlan(before, await findOriginal(looked(before)), "keep"));
    kept.character.lore_entries = [...kept.character.lore_entries.slice(1), newLoreEntry(["keeper"], "Made here.")];
    const plan = rereadPlan(kept.character, await findOriginal(kept.looked), "reread");
    expect(plan.lore.map(({ keys, origin, constant, selective, secondary_keys, comment }) =>
      ({ keys, origin, constant, selective, secondary_keys, comment }))).toEqual([
      { keys: ["boat"], origin: 1, constant: false, selective: true, secondary_keys: ["sea"], comment: "" },
      { keys: ["gull"], origin: 2, constant: true, selective: false, secondary_keys: [], comment: "" },
      { keys: ["keeper"], origin: null, constant: false, selective: false, secondary_keys: [], comment: "" },
    ]);
  });

  test("without a card the plan only changes the rules", () => {
    const current = madeBefore(MIRELA);
    expect(rereadPlan(current, null, "reread")).toEqual({
      fields: { card_rules: 2 }, lore: current.lore_entries, added: [], untouched: [], card: null,
    });
  });
});
