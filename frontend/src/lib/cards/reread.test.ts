import { crc32 } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import { data, DataError, type CardCharacter } from "@/data";
import type { LibraryItem } from "@/types";
import { newLoreEntry } from "../loreEntry";
import { cardForExport } from "./export";
import { likeness } from "./pairing";
import { FIELDS, isStorable, readCardJson } from "./read";
import { findOriginal, oldReading, rereadOffer, rereadPlan, type FoundCard } from "./reread";

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

// Every case of pairing found so far, with the pairing a person expects. Cases 1 to 27 are tests
// below; the two shapes after them stay, and the plan says so. Five rules, in five reviews, each
// fixed the case it was given and broke another: the rule now in pairing.ts was chosen against all
// of them at once, and against harnesses of random cards (see the comment on its numbers).
//
//  #  case (where it came from)                                          paired with
//  1  keys rewritten, text the same (plan)                                its own
//  2  text retouched, "The boat is red." -> "The boat is blue now." (plan) its own
//  3  one entry deleted (plan)                                            the others, their own
//  4  an entry written here under other keys (plan)                       none
//  5  two equal entries, keys written in another order (plan)             one to one
//  6  ccv3 with decorators, chara without, in another order (plan)        its own, across chunks
//  7  "Red." rewritten whole as "Blue, now." (plan, keep mode)            none: nothing of it is left
//  8  one deleted, one written here, as many as before (review 1)         the rest their own; the new none
//  9  one retouched beside one deleted (review 1)                         its own
// 10  kept with the card, then re-read; then one deleted, one written     its own, by its origin
// 11  A deleted, B "She hums at night." -> "She hums at dawn." (review 2) B
// 12  the same text under other keys (review 2)                          the most keys in common
// 13  B retouched at both ends: "Mirela hums at dawn." (0.388 alike),
//     "Mirela hums at night", "Mirela hums at night." -> "She hums at
//     dusk.", in Japanese, beside a long A (review 3)                    B
// 14  B grown by a sentence after or before, in English, French and
//     Japanese, or a long B cut to its first sentence (review 4)          B
// 15  a long B cut to "She hums at night." beside a deleted "She sings
//     at night." (review 4)                                               none: in doubt, 0.590 and
//                                                                         0.585 alike, 0.005 apart
// 16  an entry written here under the keys of a deleted one (ruling)      none
// 17  two entries written from one (ruling)                               none: in doubt
// 18  one in doubt between two, the other clearly one of them (ruling)    each its own, in any order
// 19  "boat A ship." -> "Changed A anew." (harness of review 2)           none: no run of four left
// 20  keys retouched until keys and text equal another entry of before
//     exactly, that one deleted (harness of review 2)                     that other entry: an exact
//                                                                         match is never in doubt
// 21  B's text untouched, given the keys of a deleted A whose text is
//     like it (1.000 alike to B, 0.723 to A) (review 5)                   none: one by its keys,
//                                                                         another by its very text
// 22  "Yes." rewritten "yes" beside "Grey eyes.", whose keys became
//     ["eyes"] (review 5)                                                 "yes" none; "Grey eyes." its own
// 23  "a", "old", "...", "17", "猫が", "eyes" written here under the keys
//     of a deleted entry that holds them (review 5)                      none: a single run in common
//                                                                         is chance
// 24  "Red." rewritten "Red" (review 5)                                  its own (0.667)
// 25  written here under the keys of a deleted one, in English (0.375)
//     and French (0.367, 0.375) (review 5)                                none: under the floor, 0.38
// 26  B retouched, beside a deleted A 0.174 behind it, or 0.214 (review 5) none at 0.174; B at 0.214
// 27  written here, 0.445 alike by runs of three, 0.348 by runs of four
//     (review 5)                                                          none
//  -  a few words of an entry of before written here under its keys
//     ("She is" beside "She is the keeper of…")                          that entry: for all its text
//                                                                         says, it was cut down
//  -  lines on one frame that differ by a number, one written here
//     under the keys of a deleted one                                     that one: as alike as a
//                                                                         number retouched
//
// The rule: an entry that names its origin goes with it; then the same keys (as a set) and the same
// text, never in doubt; then, among the entries of before that share the keys or the text and are
// at least 0.38 alike, the most keys in common, then the most alike. Likeness is the share of the
// runs of four neighbouring characters the two texts have in common, half over both texts and half
// over the shorter, or over both only when the shorter is a single run (four characters or fewer).
// The best is taken when no rival with as many keys in common is within 0.2 of it, no rival has
// the entry's very text when the best has not, and it is the other's best by the same rule; again
// and again as pairs settled take rivals away. Anything else is left as it is, with no origin.
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

  test("entries are matched on what they still share, and get the card's settings", () => {
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

  test("an always-on entry the old import dropped is added at its place", () => {
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
    // "Red." rewritten whole as "Blue, now." keeps nothing of its text: it can no longer be told
    // from an entry written here under the same keys, so it is left as it is (case 7 below).
    expect(plan.lore.map((entry) => entry.origin)).toEqual([0, null]);
    expect(plan.lore[1]).toMatchObject({ content: "Blue, now.", enabled: false });
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

  test("of two entries under the same keys, the one deleted does not hand its settings to the one retouched", () => {
    const card = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["Mirela"], content: "She is tall.", constant: true, extensions: { a: 1 } },
        { keys: ["Mirela"], content: "She hums at night.", extensions: { position: 4, depth: 0, b: 1 } },
      ] },
    });
    const current = madeBefore(card);
    current.lore_entries = [{ ...current.lore_entries[1], content: "She hums at dawn." }];
    const plan = rereadPlan(current, found(card), "reread");
    expect(plan.lore).toHaveLength(1);
    expect(plan.lore[0]).toMatchObject({ origin: 1, content: "She hums at dawn.", constant: false, position: 4, depth: 0 });
    const read = { ...plan.card!.read, lore_entries: plan.card!.read.lore_entries.filter(isStorable) };
    const after = { ...current, ...plan.fields, lore_entries: plan.lore };
    const exported = cardForExport(after, { ...plan.card!, read, read_at: "" }, new Date("2026-11-14T00:00:00Z"));
    const entries = (exported.v2.data.character_book as { entries: Record<string, unknown>[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ content: "She hums at dawn.", extensions: expect.objectContaining({ b: 1 }) });
    expect(entries[0].constant ?? false).toBe(false);
    expect(entries[0].extensions).not.toHaveProperty("a");

    // The same text under other keys: the one whose keys changed least is the one kept.
    const same = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["tall"], content: "She is here.", constant: true },
        { keys: ["hum", "night"], content: "She is here.", extensions: { position: 4, depth: 0 } },
      ] },
    });
    const mine = madeBefore(same);
    mine.lore_entries = [{ ...mine.lore_entries[1], keys: ["hum", "dawn"] }];
    expect(rereadPlan(mine, found(same), "reread").lore[0]).toMatchObject({ origin: 1, constant: false, position: 4 });
  });

  test("an entry retouched at both ends, beside a deleted one under the same keys, keeps its own settings", () => {
    const tallAndHums = (hums: string) => v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["Mirela"], content: "She is tall.", constant: true, extensions: { a: 1 } },
        { keys: ["Mirela"], content: hums, extensions: { position: 4, depth: 0, b: 1 } },
      ] },
    });
    const retouched = (card: unknown, content: string, mode: "reread" | "keep" = "reread") => {
      const current = madeBefore(card);
      current.lore_entries = [{ ...current.lore_entries[1], content }];
      return rereadPlan(current, found(card), mode).lore;
    };
    const card = tallAndHums("She hums at night.");
    for (const content of ["Mirela hums at dawn.", "Mirela hums at night"]) {
      const lore = retouched(card, content);
      expect(lore).toHaveLength(1);
      expect(lore[0]).toMatchObject({ origin: 1, content, constant: false, position: 4, depth: 0 });
      // The export of a card not re-read pairs the same way: the text goes over B's entry.
      expect(retouched(card, content, "keep")[0]).toMatchObject({ origin: 1, content });
    }
    // Rewritten to start like the deleted one: what it keeps of its own text still wins.
    expect(retouched(tallAndHums("Mirela hums at night."), "She hums at dusk.")[0])
      .toMatchObject({ origin: 1, constant: false, position: 4 });
    // In Japanese, and beside a long deleted entry.
    const japanese = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["ミレラ"], content: "彼女は背が高い。", constant: true },
        { keys: ["ミレラ"], content: "彼女は夜に歌を口ずさむ。", extensions: { position: 4 } },
      ] },
    });
    expect(retouched(japanese, "ミレラは夜に歌を口ずさむよ。")[0]).toMatchObject({ origin: 1, constant: false, position: 4 });
    const long = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["Mirela"], content: `She is tall and ${"walks the gallery every night with the lamp. ".repeat(12)}`, constant: true },
        { keys: ["Mirela"], content: "She hums at night.", extensions: { position: 4 } },
      ] },
    });
    expect(retouched(long, "Mirela hums at dawn.")[0]).toMatchObject({ origin: 1, constant: false, position: 4 });
  });

  /** A card of two entries under one key, A always on, B at a depth; the owner deleted A. */
  const deletedBeside = (a: string, b: string) => v2({
    name: "Mirela", description: "A lighthouse keeper.",
    character_book: { entries: [
      { keys: ["Mirela"], content: a, constant: true, extensions: { a: 1 } },
      { keys: ["Mirela"], content: b, extensions: { position: 4, depth: 0, b: 1 } },
    ] },
  });
  /** The plan for B with its text changed, A deleted. */
  const onlyB = (card: unknown, content: string, mode: "reread" | "keep" = "reread") => {
    const current = madeBefore(card);
    current.lore_entries = [{ ...current.lore_entries[1], content }];
    return { current, plan: rereadPlan(current, found(card), mode) };
  };

  test("an entry that grew, or was cut down, beside a deleted one under the same keys, keeps its own settings", () => {
    const keeper = "Mirela is the keeper of the Saltmarsh lighthouse. She has kept the lamp for sixty years and knows every reef by name.";
    const hums = "She hums at night.";
    const cases: [a: string, b: string, retouched: string][] = [
      [keeper, hums, "She hums at night. It is a shanty her mother taught her, and nobody else knows the words."],
      [keeper, hums, "Once the lamp is lit and the gallery is swept, the keeper sits by the window with her tea. She hums at night."],
      ["She is tall.", "She hums at night. The tune is an old shanty her mother taught her, about a ship that never came home, and she hums it while she trims the wick and watches the tide.", hums],
      ["Mirela garde le phare de Saltmarsh depuis soixante ans. Elle connaît chaque récif par son nom et se méfie des étrangers.",
        "Elle fredonne la nuit.", "Elle fredonne la nuit. C'est une chanson de marin que sa mère lui a apprise, et personne d'autre n'en connaît les paroles."],
      ["ミレラは六十年間、灯台を守ってきた。冬には補給船が何週間も接岸できない。", "彼女は夜に歌を口ずさむ。",
        "彼女は夜に歌を口ずさむ。それは母から教わった古い船乗りの歌で、ほかに歌詞を知る者はいない。"],
    ];
    for (const [a, b, content] of cases) {
      const card = deletedBeside(a, b);
      for (const mode of ["reread", "keep"] as const) {
        expect(onlyB(card, content, mode).plan.lore, `${mode}: ${content}`).toEqual([
          expect.objectContaining({ origin: 1, content, constant: false, position: 4, depth: 0 }),
        ]);
      }
    }
  });

  test("a pairing in doubt is no pairing: the entry keeps its own settings, and the export writes it as new", () => {
    // B cut down to its first sentence, beside a deleted A that is that sentence with one word
    // changed: the texts no longer say which one it was.
    const card = deletedBeside("She sings at night.",
      "She hums at night. The tune is an old shanty her mother taught her, about a ship that never came home, and she hums it while she trims the wick and watches the tide.");
    const { current, plan } = onlyB(card, "She hums at night.");
    expect(plan.lore).toEqual([{ ...current.lore_entries[0], origin: null }]);
    const read = { ...plan.card!.read, lore_entries: plan.card!.read.lore_entries.filter(isStorable) };
    const exported = cardForExport({ ...current, ...plan.fields, lore_entries: plan.lore }, { ...plan.card!, read, read_at: "" }, new Date("2026-11-14T00:00:00Z"));
    const entries = (exported.v2.data.character_book as { entries: Record<string, unknown>[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ content: "She hums at night." });
    expect(entries[0].constant ?? false).toBe(false);
    expect(entries[0].extensions ?? {}).not.toHaveProperty("a");
    expect(entries[0].extensions ?? {}).not.toHaveProperty("b");
  });

  test("an entry written here under the keys of a deleted one is not taken for it", () => {
    const card = deletedBeside("Mirela has kept the Saltmarsh lighthouse for sixty years.", "She hums at night.");
    const current = madeBefore(card);
    const mine = newLoreEntry(["Mirela"], "She keeps a loaded flare pistol in the kitchen drawer.");
    current.lore_entries = [current.lore_entries[1], mine];
    const plan = rereadPlan(current, found(card), "reread");
    expect(plan.lore.map((entry) => entry.origin)).toEqual([1, null]);
    expect(plan.lore[1]).toEqual(mine);
  });

  test("two entries written from one leave it to neither", () => {
    const card = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [{ keys: ["Mirela"], content: "She hums at night.", constant: true }] },
    });
    const current = madeBefore(card);
    current.lore_entries = [
      { ...current.lore_entries[0], content: "She hums at night, softly." },
      { ...current.lore_entries[0], content: "She hums at night, loudly." },
    ];
    expect(rereadPlan(current, found(card), "reread").lore.map((entry) => entry.origin)).toEqual([null, null]);
  });

  test("an entry whose rival was paired with its own is weighed again, whatever their order", () => {
    const card = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["lamp"], content: "The lamp burns whale oil.", insertion_order: 1 },
        { keys: ["lamp"], content: "The lamp burns seal oil.", insertion_order: 2 },
      ] },
    });
    const current = madeBefore(card);
    // Alone, the first is as near the one as the other; the second is clearly the seal oil one.
    const [whale, seal] = current.lore_entries;
    for (const lore of [
      [{ ...whale, content: "The lamp burns at night." }, { ...seal, content: "The lamp burns seal oil and smokes in the fog." }],
      [{ ...seal, content: "The lamp burns seal oil and smokes in the fog." }, { ...whale, content: "The lamp burns at night." }],
    ]) {
      const plan = rereadPlan({ ...current, lore_entries: lore }, found(card), "reread");
      expect(Object.fromEntries(plan.lore.map((entry) => [entry.content, entry.insertion_order]))).toEqual({
        "The lamp burns at night.": 1, "The lamp burns seal oil and smokes in the fog.": 2,
      });
    }
  });

  /** The book an export writes, from the character with the plan in it. */
  const bookAfter = (current: CardCharacter, plan: ReturnType<typeof rereadPlan>) => {
    const read = { ...plan.card!.read, lore_entries: plan.card!.read.lore_entries.filter(isStorable) };
    const exported = cardForExport({ ...current, ...plan.fields, lore_entries: plan.lore }, { ...plan.card!, read, read_at: "" }, new Date("2026-11-14T00:00:00Z"));
    return (exported.v2.data.character_book as { entries: Record<string, unknown>[] }).entries;
  };
  /** The origins a plan gives, in both modes: the re-read, and the export of a card not re-read. */
  const origins = (current: CardCharacter, card: unknown) =>
    (["reread", "keep"] as const).map((mode) => rereadPlan(current, found(card), mode).lore.map((entry) => entry.origin));

  test("an entry whose text is untouched, given the keys of a deleted one like it, is in doubt and left as it is", () => {
    const card = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["lighthouse"], content: "The Saltmarsh lighthouse is sixty feet tall and burns whale oil.", constant: true, extensions: { a: 1 } },
        { keys: ["tower"], content: "The Saltmarsh lighthouse is sixty feet tall and leans toward the sea.", extensions: { position: 4, depth: 0, b: 1 } },
      ] },
    });
    const current = madeBefore(card);
    current.lore_entries = [{ ...current.lore_entries[1], keys: ["lighthouse"] }];
    // One entry of before by its keys, another by its very text: either may be it.
    expect(likeness(current.lore_entries[0].content, oldReading(card)!.lore_entries[0].content)).toBeCloseTo(0.723, 3);
    for (const mode of ["reread", "keep"] as const) {
      const plan = rereadPlan(current, found(card), mode);
      expect(plan.lore, mode).toEqual([{ ...current.lore_entries[0], origin: null }]);
      const book = bookAfter(current, plan);
      expect(book, mode).toHaveLength(1);
      expect(book[0], mode).toMatchObject({ content: "The Saltmarsh lighthouse is sixty feet tall and leans toward the sea." });
      expect(book[0].constant ?? false, mode).toBe(false);
      expect(book[0].extensions ?? {}, mode).not.toHaveProperty("a");
    }
  });

  test("a short entry retouched does not take the settings of the one whose text it now holds", () => {
    const card = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["Brask"], content: "Yes.", extensions: { y: 1 } },
        { keys: ["Brask"], content: "Grey eyes.", constant: true, extensions: { g: 1 } },
      ] },
    });
    const current = madeBefore(card);
    current.lore_entries = [{ ...current.lore_entries[0], content: "yes" }, { ...current.lore_entries[1], keys: ["eyes"] }];
    expect(origins(current, card)).toEqual([[null, 1], [null, 1]]);
    expect(rereadPlan(current, found(card), "reread").lore[1]).toMatchObject({ keys: ["eyes"], constant: true });
  });

  test("an entry of a few characters written here is not taken for a deleted one that holds them", () => {
    for (const [deleted, written] of [
      ["She waits and watches the tide.", "a"], ["She is old and tired, and keeps the lamp.", "old"],
      ["She waits... and watches the tide.", "..."], ["Tomas drowned in 1917 off the Needle.", "17"],
      ["彼女は猫が好きだ。", "猫が"], ["Grey eyes.", "eyes"],
    ]) {
      const card = v2({
        name: "Mirela", description: "A lighthouse keeper.",
        character_book: { entries: [
          { keys: ["Mirela"], content: deleted, constant: true, extensions: { a: 1 } },
          { keys: ["boat"], content: "The boat is red." },
        ] },
      });
      const current = madeBefore(card);
      current.lore_entries = [current.lore_entries[1], newLoreEntry(["Mirela"], written)];
      expect(origins(current, card), written).toEqual([[1, null], [1, null]]);
      const book = bookAfter(current, rereadPlan(current, found(card), "keep"));
      expect(book.find((entry) => entry.content === written), written).toMatchObject({ constant: false });
      expect(book.find((entry) => entry.content === written)!.extensions ?? {}, written).not.toHaveProperty("a");
    }
    // A short entry retouched keeps its own: its few characters are most of what both texts hold.
    const red = v2({ name: "Mirela", description: "A lighthouse keeper.", character_book: { entries: [{ keys: ["boat"], content: "Red.", extensions: { position: 4 } }] } });
    const current = madeBefore(red);
    current.lore_entries = [{ ...current.lore_entries[0], content: "Red" }];
    expect(likeness("Red", "Red.")).toBeCloseTo(0.667, 3);
    expect(origins(current, red)).toEqual([[0], [0]]);
  });

  test("an entry written here, under the floor of likeness, is not taken for the deleted one", () => {
    const keys = ["council", "company"];
    const card = v2({
      name: "Kaede", description: "A sellsword captain.",
      character_book: { entries: [
        { keys, content: "Old Marrow runs the infirmary and charges nothing for burns. The winter contract pays double if the pass is held until the thaw. The northern campaign ended at Garrow Ford, where the company lost half its number in one morning.", constant: true, extensions: { a: 1 } },
        { keys, content: "A foreign envoy has rented the whole top floor of the Gilded Carp and receives no visitors." },
      ] },
    });
    const written = "Nobody in the company says the word Garrow inside the tannery. Old Marrow lost two fingers to frostbite on the northern campaign.";
    const current = madeBefore(card);
    current.lore_entries = [current.lore_entries[1], newLoreEntry(keys, written)];
    expect(likeness(written, oldReading(card)!.lore_entries[0].content)).toBeCloseTo(0.375, 3);
    expect(origins(current, card)).toEqual([[1, null], [1, null]]);
    // In French, an entry deleted, or one whose text its owner moved into the entry written here.
    for (const [key, before, now, alike] of [
      ["conseil", "Le capitaine du guet s'appelle Teodric Vane et il a jadis appartenu à la Compagnie des Cendres.",
        "Le portier s'appelle Wick, et il a dit son nom à la moitié de la ville. La Compagnie des Cendres partage sa solde en parts égales, avec deux parts pour les blessés. Une lettre scellée du conseil est arrivée la semaine dernière et Kaede ne l'a pas ouverte.", 0.367],
      ["guet", "Le capitaine du guet prélève sa part sur chaque tripot à l'est du marché aux poissons.",
        "Le capitaine du guet s'appelle Teodric Vane et il a jadis appartenu à la Compagnie des Cendres. Le marché aux poissons vend plus de secrets que de poissons une fois la nuit tombée.", 0.375],
    ] as const) {
      const french = v2({ name: "Kaede", description: "A sellsword captain.", character_book: { entries: [{ keys: [key], content: before, constant: true }] } });
      const mine = madeBefore(french);
      mine.lore_entries = [newLoreEntry([key], now)];
      expect(likeness(now, before), key).toBeCloseTo(alike, 3);
      expect(origins(mine, french), key).toEqual([[null], [null]]);
    }
  });

  test("an entry retouched is taken for its own only 0.2 ahead of a rival with as many keys in common", () => {
    const card = (rival: string) => v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["lamp"], content: `The lamp burns ${rival} until dawn, and smokes in the fog.`, constant: true },
        { keys: ["lamp"], content: "The lamp burns whale oil until dawn, and smokes in the fog.", extensions: { position: 4 } },
      ] },
    });
    const retouched = "The lamp burns whale oil and smokes at night.";
    const own = likeness(retouched, "The lamp burns whale oil until dawn, and smokes in the fog.");
    for (const [rival, gap, origin] of [["fish oil", 0.174, null], ["tallow", 0.214, 1]] as const) {
      const current = madeBefore(card(rival));
      current.lore_entries = [{ ...current.lore_entries[1], content: retouched }];
      expect(own - likeness(retouched, `The lamp burns ${rival} until dawn, and smokes in the fog.`), rival).toBeCloseTo(gap, 3);
      expect(origins(current, card(rival)), rival).toEqual([[origin], [origin]]);
    }
  });

  test("an entry written here that shares only runs of fewer than four characters is not taken", () => {
    const card = v2({
      name: "Kaede", description: "A sellsword captain.",
      character_book: { entries: [
        { keys: ["company"], content: "The northern campaign ended at Garrow Ford, where the company lost half its number in one morning.", constant: true },
      ] },
    });
    const current = madeBefore(card);
    current.lore_entries = [newLoreEntry(["company"], "Vane left the company the night before Garrow Ford.")];
    // By runs of three they would be 0.445 alike, over the floor.
    expect(likeness(current.lore_entries[0].content, oldReading(card)!.lore_entries[0].content)).toBeCloseTo(0.348, 3);
    expect(origins(current, card)).toEqual([[null], [null]]);
  });

  test("an entry rewritten with nothing left of its text is left as it is", () => {
    const card = v2({ name: "Mirela", description: "A lighthouse keeper.", character_book: { entries: [{ keys: ["boat"], content: "boat A ship.", constant: true }] } });
    const current = madeBefore(card);
    current.lore_entries = [{ ...current.lore_entries[0], content: "Changed A anew." }];
    expect(likeness("Changed A anew.", "boat A ship.")).toBe(0);
    expect(origins(current, card)).toEqual([[null], [null]]);
  });

  test("an entry whose keys became those of a deleted one with the same text is taken for it", () => {
    const card = v2({
      name: "Mirela", description: "A lighthouse keeper.",
      character_book: { entries: [
        { keys: ["lamp"], content: "Same.", constant: true },
        { keys: ["oil"], content: "Same.", extensions: { position: 4 } },
      ] },
    });
    const current = madeBefore(card);
    // The second deleted, the first given its keys: nothing tells the two apart, and an exact
    // match of keys and text is never in doubt.
    current.lore_entries = [{ ...current.lore_entries[0], keys: ["oil"] }];
    expect(origins(current, card)).toEqual([[1], [1]]);
  });

  test("re-reading a book of 300 entries under one key, half retouched, takes a moment", () => {
    // Each text's runs are counted once. Counted again for each candidate, as they once were, this
    // took 7 s on the machine it was measured on, where it now takes half a second; a phone is four
    // to six times slower.
    let seed = 7;
    const next = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const word = () => Array.from({ length: 3 + Math.floor(next() * 6) }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(next() * 26)]).join("");
    const text = () => {
      let out = "";
      while (out.length < 1200) out += `${Array.from({ length: 8 }, word).join(" ")}. `;
      return out.trim();
    };
    const card = v2({ name: "Mirela", description: "A lighthouse keeper.", character_book: { entries: Array.from({ length: 300 }, () => ({ keys: ["Mirela"], content: text() })) } });
    const current = madeBefore(card);
    current.lore_entries = current.lore_entries.map((entry, i) => (i % 2 ? { ...entry, content: `${entry.content} And more.` } : entry));
    const start = performance.now();
    const plan = rereadPlan(current, found(card), "reread");
    expect(performance.now() - start).toBeLessThan(3000);
    expect(plan.lore.filter((entry) => entry.origin !== null)).toHaveLength(300);
  });

  test("an entry the old import dropped goes after the entry of the index below it", () => {
    const plan = rereadPlan(madeBefore(BOOK), found(BOOK), "reread");
    // The card's order: lamp, the always-on entry, boat, gull; the empty one is not stored.
    expect(plan.lore.map((entry) => entry.origin)).toEqual([0, 1, 2, 3]);
  });

  test("a card re-read and left alone exports its book in its author's order", () => {
    const current = madeBefore(BOOK);
    const plan = rereadPlan(current, found(BOOK), "reread");
    const after = { ...current, ...plan.fields, lore_entries: plan.lore };
    // The server keeps the reading without the entries it does not store, as the empty one.
    const read = { ...plan.card!.read, lore_entries: plan.card!.read.lore_entries.filter(isStorable) };
    const card = cardForExport(after, { ...plan.card!, read, read_at: "" }, new Date("2026-11-14T00:00:00Z"));
    expect((card.v2.data.character_book as { entries: unknown[] }).entries)
      .toEqual((BOOK.data.character_book as { entries: unknown[] }).entries);
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

  test("a portrait the server no longer has is a portrait without a card", async () => {
    vi.spyOn(data, "file").mockRejectedValue(new DataError("Not found.", { kind: "not_found", status: 404 }));
    libraryIs([]);
    expect(await findOriginal(looked(madeBefore(MIRELA)))).toBeNull();
    libraryIs([{ filename: "mirela.json", has_avatar: false, card: MIRELA }]);
    expect((await findOriginal(looked(madeBefore(MIRELA))))?.old.name).toBe("Mirela");
  });

  test("a failure to reach the portrait is not taken for a missing card", async () => {
    vi.spyOn(data, "file").mockRejectedValue(new DataError("Offline.", { kind: "network" }));
    libraryIs([]);
    await expect(findOriginal(looked(madeBefore(MIRELA)))).rejects.toMatchObject({ kind: "network" });
  });

  test("the banner's offer lists what the plan adds and what it leaves", () => {
    const current = { ...madeBefore(BOOK), description: "Mine now." };
    const plan = rereadPlan(current, found(BOOK), "reread");
    expect(plan.added).toContainEqual({ key: "lore", count: 1 });
    expect(rereadOffer(current, found(BOOK))).toEqual({ added: plan.added, untouched: plan.untouched });
    expect(rereadOffer(current, null)).toEqual({ added: [], untouched: [] });
  });

  test("without a card the plan only changes the rules", () => {
    const current = madeBefore(MIRELA);
    expect(rereadPlan(current, null, "reread")).toEqual({
      fields: { card_rules: 2 }, lore: current.lore_entries, added: [], untouched: [], card: null,
    });
  });
});
