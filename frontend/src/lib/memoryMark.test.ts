import { expect, test } from "vitest";
import { memoryFailed } from "./memoryMark";

test.each([
  [{ memory_error: { error: "The mock was told to forget.", kind: "model_error" } }, true],
  [{ memory_error: { error: "The memory pass failed." } }, true],
  // What a model that reasons leaves of a pass: thought only, withheld with a word, or unreadable.
  [{ memory_error: { error: "The model only thought.", kind: "model_only_thought" } }, true],
  [{ memory_error: { error: "Withheld.", kind: "model_withheld", reason: "content_filter" } }, true],
  [{ memory_error: { error: "Unreadable.", kind: "model_unreadable" } }, true],
  // Cleared once a pass succeeds, or never set.
  [{ memory_error: null }, false],
  [{}, false],
])("a conversation %j is marked: %s", (conversation, marked) => {
  expect(memoryFailed(conversation)).toBe(marked);
});
