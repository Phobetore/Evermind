import { expect, test } from "vitest";
import { memoryFailed } from "./memoryMark";

test.each([
  [{ memory_error: { error: "The mock was told to forget.", kind: "model_error" } }, true],
  [{ memory_error: { error: "The memory pass failed." } }, true],
  // Cleared once a pass succeeds, or never set.
  [{ memory_error: null }, false],
  [{}, false],
])("a conversation %j is marked: %s", (conversation, marked) => {
  expect(memoryFailed(conversation)).toBe(marked);
});
