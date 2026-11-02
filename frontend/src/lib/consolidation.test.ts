import { describe, expect, test } from "vitest";
import en from "@/i18n/locales/en.json";
import { describeConsolidation } from "./consolidation";

/** A translator that shows which key and which values it was asked for, so that a
 *  test says what the person would be told without depending on the wording. */
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${JSON.stringify(vars)}` : key;

const lookup = (key: string) =>
  key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);

describe("what a consolidation says it did", () => {
  test("how many facts it left, when it merged", () => {
    expect(describeConsolidation({ before: 11, after: 3, memories: [] }, t)).toBe(
      'chat.panel.facts.consolidated {"before":11,"after":3}',
    );
  });

  test("that there were too few facts, when it was skipped for that", () => {
    expect(describeConsolidation({ before: 5, after: 5, memories: [], skipped: "too_few" }, t)).toBe(
      "chat.panel.facts.tooFewToConsolidate",
    );
  });

  test("that the facts changed meanwhile, and nothing was altered, when it was skipped for that", () => {
    expect(describeConsolidation({ before: 8, after: 8, memories: [], skipped: "changed" }, t)).toBe(
      "chat.panel.facts.changedWhileConsolidating",
    );
  });

  test.each([
    "chat.panel.facts.consolidated",
    "chat.panel.facts.tooFewToConsolidate",
    "chat.panel.facts.changedWhileConsolidating",
  ])("%s is a sentence of the interface", (key) => {
    expect(typeof lookup(key)).toBe("string");
  });
});
