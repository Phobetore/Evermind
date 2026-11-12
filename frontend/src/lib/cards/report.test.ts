import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { readCardJson } from "./read";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const readText = (text: string) => readCardJson(JSON.parse(text), text, "json")!;

describe("the report of an import", () => {
  test("a card's report says what is used and what is only kept", () => {
    expect(readText(fixture("chub-v2.json")).report).toEqual({
      used: [
        { key: "greetings", count: 3 },
        { key: "lore", count: 6 },
        { key: "secondaryKeys", count: 1 },
        { key: "depthEntries", count: 1 },
        { key: "characterNote", count: 6 },
        { key: "postHistory" },
        { key: "examples", count: 3 },
      ],
      kept: [
        { key: "extensions", names: ["chub", "talkativeness"] },
        { key: "loreNotStored", count: 2 },
        { key: "outletEntries", count: 1 },
        { key: "otherPlaces", count: 1 },
        { key: "regexKeys", count: 1 },
        { key: "decorators", count: 1 },
        { key: "loreSettings", names: ["sticky", "case_sensitive"] },
        { key: "bookSettings", names: ["scan_depth", "token_budget", "recursive_scanning"] },
        { key: "unreadFields", names: ["personality"] },
      ],
      newer: false,
    });
  });

  test("a newer version is said, and read all the same", () => {
    const text = fixture("risu-v3.json").replace('"spec_version": "3.0"', '"spec_version": "3.1"');
    const read = readText(text);
    expect(read.report.newer).toBe(true);
    expect(read.character).toMatchObject({ name: "Arisen of the Gate", nickname: "Ari" });
    expect(read.report.used).toContainEqual({ key: "nickname" });
    expect(read.report.kept).toEqual([
      { key: "extensions", names: ["risuai"] },
      { key: "decorators", count: 1 },
      { key: "groupGreetings", count: 1 },
      { key: "assets", count: 1 },
      { key: "multilingualNotes", names: ["en", "ko"] },
      // "fr": 3, which is no text: left out of the reading, so said.
      { key: "unreadFields", names: ["creator_notes_multilingual.fr"] },
    ]);
    expect(readText(fixture("risu-v3.json")).report.newer).toBe(false);
    expect(readText(fixture("chub-v2.json").replace('"spec_version": "2.0"', '"spec_version": "3.5"')).report.newer).toBe(false);
  });

  test("what the reading leaves out is said, every item of the book counted", () => {
    const report = (data: object) =>
      readCardJson({ spec: "chara_card_v2", data: { name: "N", ...data } }, "{}", "json")!.report.kept;
    expect(report({
      alternate_greetings: ["Hello.", { text: "Hi." }],
      tags: ["sea", ["storm"]],
      creator_notes_multilingual: { en: "Notes.", fr: 3, de: null },
      extensions: { depth_prompt: { prompt: ["x"], depth: 2 } },
      character_book: { entries: { 0: { keys: ["k"], content: "c" } } },
    })).toContainEqual({
      key: "unreadFields",
      names: ["alternate_greetings", "tags", "creator_notes_multilingual.fr", "extensions.depth_prompt.prompt", "character_book.entries"],
    });
    expect(report({
      creator_notes_multilingual: "Notes.", extensions: { depth_prompt: "x" }, character_book: [{ keys: ["k"], content: "c" }],
    })).toContainEqual({
      key: "unreadFields", names: ["creator_notes_multilingual", "extensions.depth_prompt", "character_book"],
    });
    // Greetings and tags that are all text, a number among them, leave nothing out.
    expect(report({ alternate_greetings: ["Hello.", 2], tags: "sea" })).toEqual([]);
    // Items of the book that are no object hold no entry, and are counted with those not stored.
    expect(report({ character_book: { entries: [1, "x", null, { keys: ["k"], content: "c" }, { keys: [], content: "c" }] } }))
      .toEqual([{ key: "loreNotStored", count: 4 }]);
    // The texts of an entry that hold something else, by the entry's index in the book.
    expect(report({
      character_book: { entries: [1, { keys: ["a", { o: 1 }], secondary_keys: [[1]], content: "c", comment: { a: 1 }, name: ["n"] }] },
    })).toEqual([{ key: "loreNotStored", count: 1 }, {
      key: "unreadFields",
      names: [
        "character_book.entries.1.keys", "character_book.entries.1.secondary_keys",
        "character_book.entries.1.comment", "character_book.entries.1.name",
      ],
    }]);
    expect(report({ character_book: { entries: [{ keys: "k", secondary_keys: { o: 1 }, content: 5, comment: null }] } }))
      .toContainEqual({ key: "unreadFields", names: ["character_book.entries.0.secondary_keys"] });
    // An entry's name is read only when its comment gives nothing: otherwise it is not said.
    expect(report({ character_book: { entries: [{ keys: ["k"], content: "c", comment: "C", name: { a: 1 } }] } }))
      .toEqual([]);
    // Evermind's own tagline that is no text.
    expect(report({ extensions: { evermind: { tagline: { a: 1 } } } }))
      .toEqual([{ key: "unreadFields", names: ["extensions.evermind.tagline"] }]);
    // A name longer than the server takes is cut there, and that is said; one of 200 is not.
    expect(report({ name: `${"é".repeat(199)}🌊x` })).toEqual([{ key: "unreadFields", names: ["name.cut"] }]);
    // A name that is no text is said as such, not as a name cut.
    expect(report({ name: { a: 1 }, description: "D." })).toEqual([{ key: "unreadFields", names: ["name"] }]);
    expect(report({ name: `${"é".repeat(199)}🌊` })).toEqual([]);
    // So is a nickname, which the card keeps whole as well.
    expect(report({ nickname: `${"é".repeat(199)}🌊x` })).toEqual([{ key: "unreadFields", names: ["nickname.cut"] }]);
    expect(report({ nickname: `${"é".repeat(199)}🌊` })).toEqual([]);
    // A flat V1 card's creatorcomment, read as its notes, that is no text; read nowhere else.
    const flat = (card: object) => readCardJson({ name: "N", ...card }, "{}", "json")!.report.kept;
    expect(flat({ creatorcomment: { a: 1 } })).toEqual([{ key: "unreadFields", names: ["creatorcomment"] }]);
    expect(flat({ creator_notes: "Notes.", creatorcomment: { a: 1 } })).toEqual([]);
    expect(report({ creatorcomment: { a: 1 } })).toEqual([]);
  });

  test("a card with nothing more than Evermind's own fields reports nothing kept", () => {
    const card = {
      spec: "chara_card_v2", spec_version: "2.0",
      data: {
        name: "Vane", description: "Terse.", personality: "", scenario: "", first_mes: "Late.", mes_example: "",
        creator_notes: "", system_prompt: "", post_history_instructions: "", tags: ["sea"], creator: "",
        character_version: "", alternate_greetings: [],
        extensions: { evermind: { kind: "character", tagline: "The ferry" } },
        character_book: { entries: [{ keys: ["tide"], content: "It turns at noon.", enabled: true, insertion_order: 0, extensions: {} }] },
      },
    };
    const { report } = readCardJson(card, JSON.stringify(card), "json")!;
    expect(report).toEqual({ used: [{ key: "greetings", count: 1 }, { key: "lore", count: 1 }], kept: [], newer: false });
  });
});
