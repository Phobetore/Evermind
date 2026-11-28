import type { SpentTotal } from "@/types";
import { describe, expect, test } from "vitest";
import { spentLineShown } from "./SpentLine";

const without = {};
const withIt = { spending: {} as never };
const spent = (total: number, unpriced_calls = 0): SpentTotal =>
  ({ total, currency: "USD", calls: 1, unpriced_calls, free: total === 0 && unpriced_calls === 0 });

describe("the line of what was spent", () => {
  test("an edition without Spending draws none, whatever it holds", () => {
    expect(spentLineShown(without, spent(3), false)).toBe(false);
    expect(spentLineShown(without, spent(3), true)).toBe(false);
  });

  test("nothing is drawn while the amount is unknown", () => {
    expect(spentLineShown(withIt, null, false)).toBe(false);
  });

  test("a line hidden at nothing is absent when nothing cost money and nothing went unpriced", () => {
    expect(spentLineShown(withIt, spent(0), true)).toBe(false);
    expect(spentLineShown(withIt, spent(0, 2), true)).toBe(true);
    expect(spentLineShown(withIt, spent(0.4), true)).toBe(true);
  });

  test("Settings draws its line at a total of nothing", () => {
    expect(spentLineShown(withIt, spent(0), false)).toBe(true);
  });
});
