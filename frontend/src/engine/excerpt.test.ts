import { readFileSync } from "node:fs";
import { expectWithin } from "@/lib/presentation/timedBudget";
import { expect, test } from "vitest";
import { EXCERPT_RULE, cardExcerpt } from "./index";

// The cases themselves are in backend/tests/cases/card_excerpt.json, run by cases.test.ts. Here: the
// time a hostile description takes, as backend/tests/test_card_excerpt.py holds it in Python.
const HOSTILE: Record<string, string> = {
  tags: "<a".repeat(500_000),
  brackets: "[".repeat(1_000_000),
  markers: "{{".repeat(500_000),
  images: "![x](".repeat(200_000),
  newlines: "\n".repeat(1_000_000),
  "one word": "a".repeat(1_000_000),
  "a block never closed": "[\n".repeat(500_000),
  "long decimal entities": ("&#" + "9".repeat(5_000) + ";").repeat(200),
  "a long hexadecimal entity": "&#x" + "f".repeat(1_000_000) + ";",
};

for (const [label, text] of Object.entries(HOSTILE)) {
  test(`a hostile description costs linear time: ${label}`, () => {
    const start = performance.now();
    const result = cardExcerpt(text, "Sélène");
    expectWithin(performance.now() - start, 1000, "count", label);
    expect(result).not.toMatch(/[<[]/);
  });
}

test("the rule number is Python's", () => {
  const source = readFileSync(new URL("../../../backend/app/services/card_text.py", import.meta.url), "utf8");
  const python = /^EXCERPT_RULE = (\d+)/m.exec(source);
  expect(python).not.toBeNull();
  expect(Number(python?.[1])).toBe(EXCERPT_RULE);
});
