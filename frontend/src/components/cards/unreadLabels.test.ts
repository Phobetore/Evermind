import { describe, expect, test } from "vitest";
import { translate } from "@/i18n/translate";
import { readCardJson } from "@/lib/cards";
import { unreadLabels } from "./unreadLabels";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

describe("the places a card held what Evermind could not read", () => {
  test("are said by the form's names, and an entry by its title, its key or its number", () => {
    const card = {
      spec: "chara_card_v2", spec_version: "2.0",
      data: {
        name: "Mirela", personality: true, first_mes: ["Hi"], creator_notes_multilingual: { fr: 1 },
        extensions: { depth_prompt: { prompt: {} } },
        character_book: { entries: [
          { keys: ["lamp"], content: "Oil.", comment: "The lamp", secondary_keys: [{}] },
          { keys: ["boat"], content: "Red.", name: {} },
          { keys: [{}], content: "Gull.", constant: true },
        ] },
      },
    };
    const read = readCardJson(card, JSON.stringify(card), "json")!;
    const paths = read.report.kept.find((line) => line.key === "unreadFields")!.names!;
    expect(paths).toContain("personality");
    expect(unreadLabels(paths, read.character, t)).toEqual([
      "Personality", "First message", "Presentation by language (fr)", "Character's note",
      "Lorebook: The lamp", "Lorebook: boat", "Lorebook: entry 3",
    ]);
  });
});
