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
    ]);
    expect(readText(fixture("risu-v3.json")).report.newer).toBe(false);
    expect(readText(fixture("chub-v2.json").replace('"spec_version": "2.0"', '"spec_version": "3.5"')).report.newer).toBe(false);
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
