import { describe, expect, test } from "vitest";
import { per100 } from "./money";

// Intl's own spaces: a no-break space between the figure and the sign.
const NBSP = " ";

describe("an amount for 100 messages", () => {
  test("two significant figures, in each language's currency writing", () => {
    expect(per100(5.7, "fr")).toBe(`5,70${NBSP}$`);
    expect(per100(5.7, "en")).toBe("$5.70");
    expect(per100(5.7, "de")).toBe(`5,70${NBSP}$`);
    expect(per100(5.7, "es")).toBe(`5,70${NBSP}$`);
    expect(per100(0.0123, "fr")).toBe(`0,012${NBSP}$`);
    expect(per100(22.4, "fr")).toBe(`22${NBSP}$`);
    expect(per100(300.4, "fr")).toBe(`300${NBSP}$`);
  });

  test("cents are always written under ten, and never from ten up", () => {
    expect(per100(0.08, "en")).toBe("$0.08");
    expect(per100(0.2814, "en")).toBe("$0.28");
    expect(per100(9.96, "en")).toBe("$10");
    expect(per100(1_349, "en")).toBe("$1,300");
    expect(per100(0.000_012_34, "en")).toBe("$0.000012");
    expect(per100(0, "en")).toBe("$0.00");
  });
});
