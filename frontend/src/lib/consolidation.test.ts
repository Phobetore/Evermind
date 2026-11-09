import { describe, expect, test } from "vitest";
import en from "@/i18n/locales/en.json";
import type { Memory } from "@/types";
import { describeConsolidation, describeExtraction } from "./consolidation";

/** A translator that shows which key and which values it was asked for, so that a
 *  test says what the person would be told without depending on the wording. */
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${JSON.stringify(vars)}` : key;

const lookup = (key: string) =>
  key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);

const fact: Memory = {
  id: "m1",
  conversation_id: "c1",
  content: "A fact.",
  source_position: 2,
  is_pinned: false,
  source: "auto",
  created_at: "2026-01-01T00:00:00Z",
};

describe("what a consolidation says it did", () => {
  test("how many facts it left, when it merged", () => {
    expect(describeConsolidation({ before: 11, after: 3, memories: [] }, t)).toBe(
      'chat.panel.facts.consolidated {"before":11,"after":3}',
    );
  });

  test("chat.panel.facts.consolidated is a sentence of the interface", () => {
    expect(typeof lookup("chat.panel.facts.consolidated")).toBe("string");
  });
});

describe("what an extraction says it did", () => {
  test("how many facts it added", () => {
    expect(
      describeExtraction({ facts_added: [fact, fact], summary: "Then.", memories: [] }, t, ""),
    ).toBe('chat.panel.facts.addedCount {"count":2}');
  });

  test("that there was nothing new, when it looked and found none", () => {
    expect(describeExtraction({ facts_added: [], summary: "Same.", memories: [] }, t, "Same.")).toBe(
      "chat.panel.facts.noneNew",
    );
  });

  test("that only the summary changed, when no fact was added", () => {
    expect(describeExtraction({ facts_added: [], summary: "Newer.", memories: [] }, t, "Older.")).toBe(
      "chat.panel.facts.summaryOnly",
    );
  });

  test.each([
    "chat.panel.facts.addedCount",
    "chat.panel.facts.noneNew",
    "chat.panel.facts.summaryOnly",
  ])(
    "%s is a sentence of the interface",
    (key) => {
      expect(typeof lookup(key)).toBe("string");
    },
  );
});
