import { translate } from "@/i18n/translate";
import { describe, expect, test } from "vitest";
import { keptOnDelete, keptSaid } from "./keptOnDelete";

const t = ((key: string, vars?: Record<string, string | number>) => translate("en", key, vars)) as never;

const without = {};
const withIt = { spending: {} as never };

describe("what a window of deletion says is kept", () => {
  test("an edition without Spending says nothing of it and offers no tick", () => {
    expect(keptOnDelete(t, without)).toBeNull();
    expect(keptSaid(t, without)).toBeNull();
  });

  test("with Spending, the sentence is said and the tick starts unticked", () => {
    const kept = keptOnDelete(t, withIt);
    expect(kept).not.toBeNull();
    expect(kept!.forgetName()).toBe(false);
    expect(keptSaid(t, withIt)).toBe("Its spending stays in Spending, under its name.");
  });
});
