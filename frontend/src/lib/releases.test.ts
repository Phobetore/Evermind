import { expect, test } from "vitest";
import { isNewer } from "./releases";

test.each([
  ["2.0.8", "2.0.7", true],
  ["2.1.0", "2.0.9", true],
  ["3.0.0", "2.9.9", true],
  ["2.0.7", "2.0.7", false],
  ["2.0.6", "2.0.7", false],
  // As numbers: as text, "2.0.10" comes before "2.0.9".
  ["2.0.10", "2.0.9", true],
  ["2.0.9", "2.0.10", false],
  ["2.10.0", "2.9.0", true],
  ["2.0.8-rc1", "2.0.7", false],
  ["0.0.1-assettest", "2.0.7", false],
  ["2.0.8+build9", "2.0.7", false],
  ["nightly", "2.0.7", false],
  ["", "2.0.7", false],
])("%s is newer than %s: %s", (candidate, current, expected) => {
  expect(isNewer(candidate, current)).toBe(expected);
});
