import { expect, test } from "vitest";
import { cleanCardDraft } from "./cardDraft";

// What parity/card_draft.json cannot say: a case file cannot hold a lone surrogate.
// backend/tests/test_card_assistant.py says the same of the Python.

test("a text that cannot be written back is left out", () => {
  const lone = String.fromCharCode(0xd800);
  expect(
    cleanCardDraft({
      name: "Kenji",
      tagline: lone,
      tags: ["a", lone, "b" + lone],
      alternate_greetings: lone,
      lore_entries: [
        { keys: [lone], content: "No keyword left." },
        { keys: ["k"], content: lone },
        { keys: ["k", lone], content: "Kept." },
      ],
    }),
  ).toEqual({ name: "Kenji", tags: ["a"], lore_entries: [{ keys: ["k"], content: "Kept." }] });
});
