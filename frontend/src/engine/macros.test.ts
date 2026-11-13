import { describe, expect, it } from "vitest";
import { expandMacros } from "./index";

// What a recorded case cannot hold: how long a card's markers take on a text built to be slow.

describe("a card's markers", () => {
  it("unclosed markers take linear time", () => {
    // A marker's body holds no brace, so an unclosed one ends at the next: otherwise each start
    // would scan to the end of the text, some 10^12 steps on this one.
    for (const unit of ["{{random:", "{{//"]) {
      const text = unit.repeat(Math.floor(7_000_000 / unit.length));
      const start = performance.now();
      expect(expandMacros(text, "Serana", "Alex", "c1")).toBe(text);
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });
});
