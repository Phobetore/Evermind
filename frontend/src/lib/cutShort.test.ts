import { expect, test } from "vitest";
import { describeCeiling, isCutAtCeiling, isCutShort } from "./cutShort";
import { translate } from "@/i18n/translate";

test("the version on screen is one the server says was cut short", () => {
  expect(isCutShort({ meta: { interrupted: [1] }, active_index: 1 })).toBe(true);
  expect(isCutShort({ meta: { interrupted: [0, 2] }, active_index: 2 })).toBe(true);
});

test("another version was, or none", () => {
  expect(isCutShort({ meta: { interrupted: [1] }, active_index: 0 })).toBe(false);
  expect(isCutShort({ meta: { interrupted: [] }, active_index: 0 })).toBe(false);
  expect(isCutShort({ meta: {}, active_index: 0 })).toBe(false);
});

test("what is not a list is no mark", () => {
  expect(isCutShort({ meta: { interrupted: false }, active_index: 0 })).toBe(false);
  expect(isCutShort({ meta: { interrupted: "yes" }, active_index: 0 })).toBe(false);
});

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${JSON.stringify(vars)}` : key;

test("a version the connection's max tokens cut says so, with the number when it is known", () => {
  expect(describeCeiling({ meta: { ceiling: { "1": 1024 } }, active_index: 1 }, t))
    .toBe('chat.message.cutAtCeiling {"tokens":1024}');
  expect(describeCeiling({ meta: { ceiling: { "0": null } }, active_index: 0 }, t))
    .toBe("chat.message.cutAtCeilingUnset");
});

test("another version was cut by it, or none, or one that was stopped", () => {
  expect(describeCeiling({ meta: { ceiling: { "1": 1024 } }, active_index: 0 }, t)).toBeNull();
  expect(describeCeiling({ meta: {}, active_index: 0 }, t)).toBeNull();
  expect(describeCeiling({ meta: { interrupted: [0] }, active_index: 0 }, t)).toBeNull();
  expect(describeCeiling({ meta: { ceiling: [0] }, active_index: 0 }, t)).toBeNull();
  expect(describeCeiling({ meta: { ceiling: { "0": "many" } }, active_index: 0 }, t))
    .toBe("chat.message.cutAtCeilingUnset");
});

test.each(["en", "fr", "de", "es"] as const)("in %s, the line names the number", (locale) => {
  const line = describeCeiling({ meta: { ceiling: { "0": 4096 } }, active_index: 0 },
    (k, vars) => translate(locale, k, vars))!;
  expect(line).toMatch(/4[\s.,  ]?096/);
  expect(line).not.toContain("chat.message");
  const unset = describeCeiling({ meta: { ceiling: { "0": null } }, active_index: 0 },
    (k, vars) => translate(locale, k, vars))!;
  expect(unset).not.toContain("chat.message");
});

test("whether the version on screen was cut by the max tokens, for a reply that is no longer the last", () => {
  expect(isCutAtCeiling({ meta: { ceiling: { "1": 1024 } }, active_index: 1 })).toBe(true);
  expect(isCutAtCeiling({ meta: { ceiling: { "0": null } }, active_index: 0 })).toBe(true);
  expect(isCutAtCeiling({ meta: { ceiling: { "1": 1024 } }, active_index: 0 })).toBe(false);
  expect(isCutAtCeiling({ meta: { interrupted: [0] }, active_index: 0 })).toBe(false);
  expect(isCutAtCeiling({ meta: { ceiling: [0] }, active_index: 0 })).toBe(false);
});

test.each(["en", "fr", "de", "es"] as const)("in %s, an older cut reply has a short mark of its own", (locale) => {
  const mark = translate(locale, "chat.message.cutAtCeilingShort");
  expect(mark).not.toContain("chat.message");
  expect(mark).not.toBe(translate(locale, "chat.message.interrupted"));
});
