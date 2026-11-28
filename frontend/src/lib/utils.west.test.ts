import { afterAll, describe, expect, test, vi } from "vitest";
import { dayMonth } from "./utils";

// West of UTC, set before anything reads a date: here UTC's midnight of a day is still the day
// before, so a bare date read as UTC would be said a day early.
const zoneBefore = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  return before;
});

afterAll(() => {
  if (zoneBefore === undefined) delete process.env.TZ;
  else process.env.TZ = zoneBefore;
});

describe("a day west of UTC", () => {
  test("a bare date is that day, not the evening before", () => {
    expect(new Date("2026-11-24").getDate()).toBe(23);
    expect(dayMonth("2026-11-24", "en", new Date(2026, 10, 25, 15))).toBe("November 24");
    expect(dayMonth("2027-01-01", "en", new Date(2026, 10, 25, 15))).toBe("January 1, 2027");
  });
});
