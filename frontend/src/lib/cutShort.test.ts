import { expect, test } from "vitest";
import { isCutShort } from "./cutShort";

test("the version on screen is one the server says was cut short", () => {
  expect(isCutShort({ meta: { interrupted: [1] }, active_index: 1 })).toBe(true);
  expect(isCutShort({ meta: { interrupted: [0, 2] }, active_index: 2 })).toBe(true);
});

test("another version was, or none", () => {
  expect(isCutShort({ meta: { interrupted: [1] }, active_index: 0 })).toBe(false);
  expect(isCutShort({ meta: { interrupted: [] }, active_index: 0 })).toBe(false);
  expect(isCutShort({ meta: {}, active_index: 0 })).toBe(false);
});

test("a reply stored by an older version reads as the version active", () => {
  expect(isCutShort({ meta: { interrupted: true }, active_index: 0 })).toBe(true);
  expect(isCutShort({ meta: { interrupted: true }, active_index: 3 })).toBe(true);
});

test("what is neither is no mark", () => {
  expect(isCutShort({ meta: { interrupted: false }, active_index: 0 })).toBe(false);
  expect(isCutShort({ meta: { interrupted: "yes" }, active_index: 0 })).toBe(false);
});
