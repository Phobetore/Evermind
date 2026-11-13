import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { CardCharacter, StoredCard } from "@/data";
import { newLoreEntry } from "../loreEntry";
import { cardForExport } from "./export";
import { exportWarnings, readCardBytes } from "./index";
import { withCards } from "./png";
import { isStorable, readCardJson, type ReadCard } from "./read";

// A PNG of one pixel, without any card.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const NOW = new Date("2026-11-12T00:00:00Z");
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const readText = (text: string) => readCardJson(JSON.parse(text), text, "json")!;
const readObject = (card: object) => readText(JSON.stringify(card));

/** What the server keeps of a reading: the card, and the reading less the entries it does not keep. */
function stored(read: ReadCard): StoredCard {
  return {
    ...read.original,
    read: { ...read.character, lore_entries: read.character.lore_entries.filter(isStorable) },
    read_at: "2026-11-12T00:00:00Z",
  };
}

/** The card of a fixture, as the server keeps it, and its text parsed. */
function kept(text: string) {
  return { kept: stored(readText(text)), card: JSON.parse(text) };
}

/** The export of a kept card whose columns `change` turns into what Evermind holds now. */
const exported = (card: StoredCard, change: (read: CardCharacter) => CardCharacter = (read) => read) =>
  cardForExport(change(structuredClone(card.read)), card, NOW);

type Entry = Record<string, unknown> & { extensions: Record<string, unknown> };
const entriesOf = (data: Record<string, unknown>) => (data.character_book as { entries: Entry[] }).entries;

/** The part of a V2 card that V2 requires, and the hand-written fixtures may leave out. */
const withBookExtensions = (data: Record<string, unknown>) => {
  const book = data.character_book as Record<string, unknown> | undefined;
  return book ? { ...data, character_book: { extensions: {}, ...book } } : data;
};

describe("an export of a card that was read", () => {
  test("an untouched card comes out as it came in", () => {
    const st = JSON.parse(fixture("sillytavern-export.json"));
    const [lamp, storm, ...rest] = st.data.character_book.entries;
    // An entry with no text, and an item that is no entry, in the middle.
    st.data.character_book.entries = [lamp, storm, { keys: ["empty"], content: "" }, 1, ...rest];
    const texts = [
      ...["chub-v2.json", "risu-v2-backfill.json", "risu-v3.json", "sillytavern-export.json"].map(fixture),
      JSON.stringify(st, null, 2),
    ];
    for (const text of texts) {
      const { kept: card, card: original } = kept(text);
      const out = exported(card);
      const v3 = original.spec === "chara_card_v3";
      expect(out.json).toBe(v3 ? "v3" : "v2");
      const data = (v3 ? out.v3 : out.v2).data;
      expect(data).toEqual(v3 ? original.data : withBookExtensions(original.data));
      expect(data.modification_date).toBe(original.data.modification_date);
    }
  });

  test("an entry keeps what Evermind does not read through an edit, a deletion and an addition", () => {
    const { kept: card, card: original } = kept(fixture("sillytavern-export.json"));
    const [lamp, , rock, log] = entriesOf(original.data);
    const out = exported(card, (read) => {
      const [first, , third, fourth] = read.lore_entries;
      const added = { ...newLoreEntry(["bell"], "The bell is rung at dawn."), comment: "The bell", depth: 2, role: "user" as const };
      return { ...read, lore_entries: [added, fourth, third, { ...first, content: "The lamp burns seal oil now." }] };
    });
    const entries = entriesOf(out.v2.data);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({
      keys: ["bell"], content: "The bell is rung at dawn.", enabled: true, comment: "The bell", constant: false,
      selective: false, secondary_keys: [], insertion_order: 100, position: "after_char", use_regex: false,
      extensions: {
        selectiveLogic: 0, position: 1, depth: 2, role: 1, match_whole_words: true,
        exclude_recursion: false, prevent_recursion: false,
      },
    });
    expect(entries[1]).toEqual(log);
    expect(entries[2]).toEqual(rock);
    expect(entries[3]).toEqual({ ...lamp, content: "The lamp burns seal oil now." });
    expect(entries[3]).toMatchObject({ id: 0, extensions: { display_index: 0, probability: 100, automation_id: "" } });
    expect(entries.map((entry) => entry.id)).not.toContain(1);
  });

  test("an entry Evermind never received is kept in the export, at its place", () => {
    const entries = [
      { keys: ["none"], content: "   " },
      { keys: ["a"], content: "A." },
      1,
      { keys: ["b"], content: "B." },
      // Kept by JavaScript's trim, refused by the server's strip.
      { keys: ["c"], content: "\x1c" },
      { keys: ["d"], content: "D." },
    ];
    const { kept: card } = kept(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "N", character_book: { entries } } }));
    expect(card.read.lore_entries.map((entry) => entry.origin)).toEqual([1, 3, 5]);
    const out = exported(card, (read) => ({ ...read, lore_entries: [...read.lore_entries].reverse() }));
    expect(entriesOf(out.v2.data)).toEqual([entries[0], entries[5], entries[3], entries[4], entries[1], entries[2]]);
  });

  test("a field changed in Evermind wins, and only that one is written", () => {
    const { kept: card, card: original } = kept(fixture("chub-v2.json"));
    const out = exported(card, (read) => ({ ...read, description: "Runs the harbor, and the town with it." }));
    expect(out.v2.data).toEqual({ ...original.data, description: "Runs the harbor, and the town with it." });
    expect(entriesOf(out.v2.data)[0].position).toBe("0");
  });

  test("a reading rule changed later does not pass for an edit", () => {
    const { kept: card, card: original } = kept(fixture("chub-v2.json"));
    // Read once by a rule that kept the tags in another case, and untouched since.
    const tags = ["Harbor", "harbor", "Merchant"];
    const older = { ...card, read: { ...card.read, tags } };
    const out = cardForExport({ ...structuredClone(card.read), tags }, older, NOW);
    expect(out.v2.data.tags).toEqual(original.data.tags);
  });

  test("a V2 card also comes out as a true V3", () => {
    const { kept: card } = kept(fixture("risu-v2-backfill.json"));
    const out = exported(card);
    expect(out.v3).toMatchObject({ spec: "chara_card_v3", spec_version: "3.0" });
    expect(out.v3.data.group_only_greetings).toEqual([]);
    expect(entriesOf(out.v3.data).map((entry) => entry.use_regex)).toEqual([false, false]);
    expect(out.v2).toMatchObject({ spec: "chara_card_v2", spec_version: "2.0" });
    expect(entriesOf(out.v2.data).map((entry) => entry.use_regex)).toEqual([undefined, undefined]);
    // A setting the card has is kept as it is.
    const st = exported(kept(fixture("sillytavern-export.json")).kept);
    expect(entriesOf(st.v3.data).map((entry) => entry.use_regex)).toEqual([true, true, true, true]);
    expect((st.v3.data.character_book as Record<string, unknown>).extensions).toEqual({});
  });

  test("the date of change moves only when something changed", () => {
    const v3 = kept(fixture("risu-v3.json")).kept;
    expect(exported(v3).v3.data.modification_date).toBe(1794049611);
    expect(exported(v3, (read) => ({ ...read, name: "Arisen" })).v3.data.modification_date).toBe(NOW.getTime() / 1000);
    const v2 = kept(fixture("risu-v2-backfill.json")).kept;
    expect(exported(v2).v3.data).not.toHaveProperty("modification_date");
    expect(exported(v2, (read) => ({ ...read, lore_entries: read.lore_entries.slice(1) })).v3.data.modification_date)
      .toBe(NOW.getTime() / 1000);
  });

  test("a flat V1 card comes out as V2, its root keys kept", () => {
    const flat = {
      name: "Vane", description: "Terse.", personality: "Dry", scenario: "A dock.", first_mes: "Late.",
      mes_example: "<START>", creatorcomment: "Written in a hurry.", talkativeness: "0.5",
      chat: "Vane - 2026-11-12@10h00m00s", create_date: "2026-11-12@10h00m00s", tags: ["sea"],
    };
    const out = exported(kept(JSON.stringify(flat)).kept);
    expect(out.json).toBe("v2");
    expect(out.v2).toEqual({
      spec: "chara_card_v2", spec_version: "2.0", ...flat,
      data: {
        name: "Vane", description: "Terse.", personality: "Dry", scenario: "A dock.", first_mes: "Late.",
        mes_example: "<START>", creator_notes: "Written in a hurry.", tags: ["sea"],
      },
    });
    // The flat shape of Pygmalion, the other one there is, loses its flat fields.
    const pygmalion = JSON.parse(fixture("pygmalion-flat.json"));
    const bellamy = exported(kept(JSON.stringify({ ...pygmalion, source: "a site" })).kept);
    expect(bellamy.v2).toEqual({
      spec: "chara_card_v2", spec_version: "2.0", source: "a site",
      data: {
        name: "Bellamy", description: pygmalion.char_persona, first_mes: pygmalion.char_greeting,
        scenario: pygmalion.world_scenario, mes_example: pygmalion.example_dialogue,
      },
    });
  });

  test("the V1 copies at the root follow their data", () => {
    const { kept: card, card: original } = kept(fixture("sillytavern-export.json"));
    const out = exported(card, (read) => ({
      ...read, description: "A keeper who has seen everything.", tags: ["sea", "storm"], creator_notes: "New notes.",
    }));
    expect(out.v2).toMatchObject({
      description: "A keeper who has seen everything.", tags: ["sea", "storm"], creatorcomment: "New notes.",
      name: "Mirelle", personality: "Patient", chat: original.chat,
      data: { description: "A keeper who has seen everything.", tags: ["sea", "storm"], creator_notes: "New notes." },
    });
  });
});

describe("an export of a card made here", () => {
  test("a card made here exports its settings in SillyTavern's places, and the V1 copies", () => {
    const character: CardCharacter = {
      kind: "scenario", name: "Vane", tagline: "The ferry", description: "Terse.", personality: "Dry",
      scenario: "A dock.", greeting: "Late.", alternate_greetings: ["Early."], example_dialogues: "<START>",
      system_prompt: "S", post_history_instructions: "P", creator_notes: "N", tags: ["sea"], creator: "C",
      character_version: "2", nickname: "", character_note: "Vane never smiles.", character_note_depth: 3,
      character_note_role: "assistant", creator_notes_multilingual: {}, card_rules: 2,
      lore_entries: [{
        ...newLoreEntry(["tide"], "It turns at noon."), comment: "Tide", constant: true, selective: true,
        secondary_keys: ["noon"], selective_logic: 3, insertion_order: 7, position: 0, depth: 6, role: "assistant",
        whole_words: false, exclude_recursion: true, prevent_recursion: true,
      }],
    };
    const out = cardForExport(character, null, NOW);
    expect(out.json).toBe("v2");
    expect(out.v2).toMatchObject({
      spec: "chara_card_v2", spec_version: "2.0",
      name: "Vane", description: "Terse.", personality: "Dry", scenario: "A dock.", first_mes: "Late.",
      mes_example: "<START>", creatorcomment: "N", tags: ["sea"],
      data: {
        name: "Vane", first_mes: "Late.", mes_example: "<START>", creator_notes: "N", system_prompt: "S",
        post_history_instructions: "P", creator: "C", character_version: "2", alternate_greetings: ["Early."],
        tags: ["sea"],
        extensions: {
          evermind: { kind: "scenario", tagline: "The ferry" },
          depth_prompt: { prompt: "Vane never smiles.", depth: 3, role: "assistant" },
        },
      },
    });
    expect(out.v2.data.character_book).toEqual({
      extensions: {},
      entries: [{
        keys: ["tide"], content: "It turns at noon.", enabled: true, comment: "Tide", constant: true,
        selective: true, secondary_keys: ["noon"], insertion_order: 7, position: "before_char", use_regex: false,
        extensions: {
          selectiveLogic: 3, position: 0, depth: 6, role: 2, match_whole_words: false,
          exclude_recursion: true, prevent_recursion: true,
        },
      }],
    });
    // No note, no place for one.
    const plain = cardForExport({ ...character, character_note: "" }, null, NOW);
    expect(plain.v2.data.extensions).toEqual({ evermind: { kind: "scenario", tagline: "The ferry" } });
    expect(plain.v3).toMatchObject({ spec: "chara_card_v3", spec_version: "3.0", data: { group_only_greetings: [] } });
  });
});

describe("what an exported file cannot do", () => {
  /** A card of `megabytes` of base64 in its extensions, its export, and that export in a PNG. */
  function large(megabytes: number) {
    const read = readObject({
      spec: "chara_card_v2", spec_version: "2.0",
      data: { name: "Large", extensions: { risuai: { image: "A".repeat(megabytes * 1024 * 1024) } } },
    });
    const out = exported(stored(read));
    return { read, out, png: withCards(PNG, out.v2, out.v3) };
  }

  test("Evermind takes back its own PNG export of a card of four megabytes", async () => {
    const { read, out, png } = large(4);
    const back = await readCardBytes(new Uint8Array(await png.arrayBuffer()), "large.png");
    expect(back.read.character).toEqual(read.character);
    expect(exportWarnings("png", png.size, out.v3.data, false)).toEqual([]);
  });

  test("a PNG export too large to take back says so", async () => {
    const { out, png } = large(6);
    expect(png.size).toBeGreaterThan(15 * 1024 * 1024);
    expect(exportWarnings("png", png.size, out.v3.data, false)).toEqual(["tooLarge"]);
    await expect(readCardBytes(new Uint8Array(await png.arrayBuffer()), "large.png")).rejects.toMatchObject({ kind: "file_too_large" });
    // The JSON, which Evermind takes back whatever its size, is not said to be too large.
    expect(exportWarnings("json", png.size, out.v3.data, false)).toEqual([]);
  });

  test("images joined to a V3 card are said to be left behind", () => {
    const data = { name: "N", assets: [{ type: "icon", uri: "ccdefault:", name: "main", ext: "png" }, { type: "emotion", uri: "__asset:0", name: "smile", ext: "png" }] };
    expect(exportWarnings("json", 100, data, false)).toEqual(["assetsLeft"]);
    expect(exportWarnings("png", 100, data, false)).toEqual(["assetsLeft"]);
    expect(exportWarnings("png", 100, data, true)).toEqual([]);
    expect(exportWarnings("json", 100, { name: "N", assets: [{ type: "icon", uri: "ccdefault:" }] }, false)).toEqual([]);
  });
});
