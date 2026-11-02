import { expect, test } from "vitest";
import { codePoints, sliceCodePoints } from "./text";

// What len(s) and s[:n] give in Python, on text where UTF-16 units and code
// points part ways. A lone surrogate, which a cut string can leave, is one
// code point in both.
test.each([
  ["", 0],
  ["abc", 3],
  ["\u00e9", 1],
  ["\u{1F600}", 1],
  ["\u{1F1EB}\u{1F1F7}", 2],
  ["\u{1F468}\u200d\u{1F469}\u200d\u{1F467}", 5],
  ["a\u{1F600}b", 3],
  ["\ud83d", 1],
  ["\ude00", 1],
  ["\ud83dx", 2],
  ["\ude00\ud83d", 2],
])("codePoints(%j) -> %j", (text, count) => expect(codePoints(text)).toBe(count));

test.each([
  ["abc", 0, ""],
  ["abc", 2, "ab"],
  ["abc", 3, "abc"],
  ["abc", 40, "abc"],
  ["", 5, ""],
  ["a\u{1F600}b", 1, "a"],
  ["a\u{1F600}b", 2, "a\u{1F600}"],
  ["\u{1F600}\u{1F600}", 1, "\u{1F600}"],
  ["\u{1F1EB}\u{1F1F7}", 1, "\u{1F1EB}"],
  ["\ud83dx", 1, "\ud83d"],
])("sliceCodePoints(%j, %j) -> %j", (text, end, expected) =>
  expect(sliceCodePoints(text, end)).toBe(expected),
);
