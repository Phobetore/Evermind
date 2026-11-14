import { describe, expect, it } from "vitest";
import { matchLore } from "./index";

// What a recorded case cannot hold: how long the lorebook takes on a card built to be slow.

describe("the lorebook", () => {
  it("a chained lorebook of a thousand entries takes linear time", () => {
    // Each entry calls the next: a full scan of the whole text at each pass would take
    // minutes, where looking only at what each pass added takes a moment.
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      keys: [`k${i}`],
      content: `k${i + 1} ` + "x".repeat(200),
    }));
    const messages = [{ role: "user", variants: ["k0"], active_index: 0, position: 0 }];
    const start = performance.now();
    const found = matchLore(entries, messages, 2, 10 ** 9);
    expect(found).toHaveLength(1000);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
