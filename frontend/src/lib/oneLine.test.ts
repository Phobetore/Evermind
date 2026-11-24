import { expect, test } from "vitest";
import { oneLine } from "./oneLine";

/** A line of so many characters at most, each one wide. */
const upTo = (most: number) => (line: string) => [...line].length <= most;

const HINT = "Write to Ottoline Wilhelmina… (*asterisks* for your actions)";

test("a text that fits is left whole", () => {
  expect(oneLine(HINT, upTo(HINT.length))).toBe(HINT);
  expect(oneLine("", upTo(0))).toBe("");
});

test("a text that does not fit ends where its room does, and says it goes on", () => {
  expect(oneLine(HINT, upTo(26))).toBe("Write to Ottoline Wilhelm…");
  expect(oneLine(HINT, upTo(HINT.length - 1))).toBe("Write to Ottoline Wilhelmina… (*asterisks* for your action…");
});

test("what ends the cut is not left before the ellipsis", () => {
  // Cut after "Wilhelmina… (", the text's own ellipsis and the bracket go, and one ellipsis is drawn.
  expect(oneLine(HINT, upTo(33))).toBe("Write to Ottoline Wilhelmina…");
});

test("a name with no space keeps what fits of it", () => {
  const unbroken = "Write to OttolineWilhelminaFairweather… (*asterisks* for your actions)";
  expect(oneLine(unbroken, upTo(20))).toBe("Write to OttolineWi…");
});

test("what it keeps always fits", () => {
  for (let most = 1; most <= HINT.length; most++) {
    expect([...oneLine(HINT, upTo(most))].length, `at ${most}`).toBeLessThanOrEqual(most);
  }
});

test("with no room, only the ellipsis", () => {
  expect(oneLine(HINT, upTo(1))).toBe("…");
  expect(oneLine(HINT, upTo(0))).toBe("…");
});

test("a character outside the basic plane is never split", () => {
  expect(oneLine("🐉🐉🐉🐉🐉", upTo(3))).toBe("🐉🐉…");
});
