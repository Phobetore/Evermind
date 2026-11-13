import { existsSync, readdirSync, readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { describe, expect, test } from "vitest";
import type { CardCharacter } from "@/data";
import { newLoreEntry } from "../loreEntry";
import { cardForExport } from "./export";
import { cardFile, cardToCharacter, readCardFile } from "./index";
import { withCards } from "./png";

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const VANE = {
  kind: "scenario" as const, name: "Vane", tagline: "The ferry", description: "Terse.", personality: "Dry",
  scenario: "A dock.", greeting: "Late.", alternate_greetings: ["Early."], example_dialogues: "<START>",
  system_prompt: "S", post_history_instructions: "P", creator_notes: "N", tags: ["sea"], creator: "C",
  character_version: "2", nickname: "", character_note: "", character_note_depth: 4,
  character_note_role: "system" as const, creator_notes_multilingual: {}, card_rules: 2 as const,
};
const LORE = [
  { ...newLoreEntry(["tide"], "It turns at noon."), enabled: false, insertion_order: 20 },
  { ...newLoreEntry(["bell", "Bell"], "It rings."), insertion_order: 10 },
];
/** The card a character made here exports. */
const cardOf = (character: CardCharacter) => cardForExport(character, null, new Date("2026-11-12T00:00:00Z"));

/** A tEXt chunk, put before the end of the PNG. */
function withText(png: Uint8Array<ArrayBuffer>, ...texts: [keyword: string, text: string][]) {
  const chunks = texts.map(([keyword, text]) => {
    const body = new TextEncoder().encode(`tEXt${keyword}\0${text}`);
    const chunk = new Uint8Array(body.length + 8);
    new DataView(chunk.buffer).setUint32(0, body.length - 4);
    chunk.set(body, 4);
    new DataView(chunk.buffer).setUint32(body.length + 4, crc32(body));
    return chunk;
  });
  return new File([png.subarray(0, -12), ...chunks, png.subarray(-12)], "card.png");
}

/** What a card made of VANE and LORE gives back: the fields, each entry's keys, text and switch,
 *  its index in the card, and its own order, which the card writes as it is. */
function survives(character: CardCharacter) {
  expect(character).toMatchObject(VANE);
  expect(character.lore_entries.map(({ keys, content, enabled }) => ({ keys, content, enabled })))
    .toEqual(LORE.map(({ keys, content, enabled }) => ({ keys, content, enabled })));
  expect(character.lore_entries.map((entry) => entry.origin)).toEqual([0, 1]);
  expect(character.lore_entries.map((entry) => entry.insertion_order)).toEqual([20, 10]);
}

const base64 = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
const kindOf = (file: File) => readCardFile(file).catch((error) => error.kind);

describe("the card codec", () => {
  test("a character and its lorebook come back from the card made of them", () => {
    const card = cardOf({ ...VANE, lore_entries: LORE }).v2;
    expect(card.spec).toBe("chara_card_v2");
    expect((card.data.character_book as { entries: { insertion_order: number }[] }).entries
      .map((e) => e.insertion_order)).toEqual([20, 10]);
    survives(cardToCharacter(JSON.parse(JSON.stringify(card)))!);
  });

  test("a flat card reads, and a name is never empty nor longer than the server takes", () => {
    expect(cardToCharacter({ name: " ", first_mes: "Hi." })).toMatchObject({ name: "Unnamed", greeting: "Hi.", kind: "character" });
    expect(cardToCharacter({ name: "😀".repeat(250) })!.name).toBe("😀".repeat(200));
  });

  test.each([[[1]], [{}], ["Vane"], [null], [{ data: {} }], [{ spec: "chara_card_v2", data: { tags: ["x"] } }]])(
    "%j is no card", (value) => expect(cardToCharacter(value)).toBeNull(),
  );

  test("a field of another type is absent, a number is text, and one text is a list of one", () => {
    expect(cardToCharacter({
      name: "N", tags: 5, description: { a: 1 }, alternate_greetings: "Hi.", creator: 7, personality: true,
      character_book: { entries: [1, { keys: " k ", content: "c", insertion_order: "abc" }, { keys: [], content: "x" }] },
    })).toMatchObject({
      tags: ["5"], description: "", alternate_greetings: ["Hi."], creator: "7", personality: "",
      lore_entries: [{ keys: ["k"], content: "c", enabled: true, origin: 1, insertion_order: 100 }, { keys: [], content: "x", origin: 2 }],
    });
  });
});

test("every card the library ships reads, with its JPEG portrait beside it", () => {
  const shelf = new URL("../../../../library/", import.meta.url);
  const cards = readdirSync(shelf).filter((name) => name.endsWith(".json"));
  expect(cards.length).toBeGreaterThan(0);
  for (const name of cards) {
    expect(cardToCharacter(JSON.parse(readFileSync(new URL(name, shelf), "utf8")))?.name, name).toBeTruthy();
    expect(existsSync(new URL(name.replace(".json", ".jpg"), shelf)), name).toBe(true);
  }
});

describe("a card file", () => {
  test("a JSON card reads, with a byte order mark too", async () => {
    const file = new File(["\uFEFF" + JSON.stringify({ name: "Vane" })], "vane.json");
    expect(await readCardFile(file)).toMatchObject({ read: { character: { name: "Vane" } }, portrait: null });
  });

  test("half of an emoji, where a card site cut one, reads as the replacement character", async () => {
    // The escapes as the file holds them: a high surrogate with no partner, and a low one alone.
    const file = new File([String.raw`{"spec":"chara_card_v2","data":{"name":"Broken \ud83d",
      "description":"She smiles \ud83d","first_mes":"Hello \uD83D\uDE00","tags":["\ude00"],
      "character_book":{"entries":[{"keys":["k\ud83d"],"content":"\ud83d"}]}}}`], "broken-emoji.json");
    expect((await readCardFile(file)).read.character).toMatchObject({
      name: "Broken \uFFFD", description: "She smiles \uFFFD", greeting: "Hello \u{1F600}", tags: ["\uFFFD"],
      lore_entries: [{ keys: ["k\uFFFD"], content: "\uFFFD", enabled: true, origin: 0 }],
    });
  });

  test("what is no card says so, and so does a file too large, before it is read", async () => {
    expect(await kindOf(new File(["[1]"], "a.json"))).toBe("unrecognized_card_file");
    expect(await kindOf(new File([new Uint8Array([0xff, 0xd8, 0xff])], "a.jpg"))).toBe("unrecognized_card_file");
    expect(await kindOf(new File([PNG], "a.png"))).toBe("png_without_card");
    expect(await kindOf(new File([new Uint8Array(15 * 1024 * 1024 + 1)], "a.json"))).toBe("file_too_large");
  });

  test("a card written into a PNG reads back, and the PNG is its portrait", async () => {
    const { v2, v3 } = cardOf({ ...VANE, lore_entries: LORE });
    const png = new Uint8Array(await withCards(PNG, v2, v3).arrayBuffer());
    for (let at = 8; at < png.length;) {
      const view = new DataView(png.buffer, at);
      const length = view.getUint32(0);
      expect(view.getUint32(length + 8), "a chunk whose CRC is wrong").toBe(crc32(png.subarray(at + 4, at + 8 + length)));
      at += length + 12;
    }
    const { read, portrait } = await readCardFile(new File([png], "vane.png"));
    survives(read.character);
    expect(portrait!.type).toBe("image/png");
  });

  test("a card's file is named after it, less what a file name cannot hold", async () => {
    // A backslash, the mark that turns text around, and a bell.
    const refused = '/:*?"<>|' + String.fromCharCode(92, 0x202e, 7);
    const made = { ...VANE, id: "c1", has_card: false, avatar_url: null, lore_entries: [] };
    const json = await cardFile({ ...made, name: `Va${refused}ne` }, "json");
    expect(json.filename).toBe("Vane.json");
    expect(JSON.parse(await json.blob.text()).data.first_mes).toBe("Late.");
    expect((await cardFile({ ...made, name: refused }, "json")).filename).toBe("card.json");
  });

  test("ccv3 is read first, and chara when ccv3 is not a card", async () => {
    const card = (name: string) => base64({ data: { name } });
    expect((await readCardFile(withText(PNG, ["ccv3", card("V3")], ["chara", card("V2")]))).read.character.name).toBe("V3");
    expect((await readCardFile(withText(PNG, ["chara", base64([1])], ["ccv3", card("V3")]))).read.character.name).toBe("V3");
    expect((await readCardFile(withText(PNG, ["chara", "not base64!"], ["ccv3", card("V3")]))).read.character.name).toBe("V3");
    expect((await readCardFile(withText(PNG, ["ccv3", "not base64!"], ["chara", card("V2")]))).read.character.name).toBe("V2");
    expect(await kindOf(withText(PNG, ["chara", base64("Vane")]))).toBe("png_without_card");
  });
});
