import { expect, test } from "vitest";
import { ceilingTokens, describeCeiling, describeCut, isCutAtCeiling, isCutShort } from "./cutShort";
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

test("the figure a version was cut at, when the line has one", () => {
  expect(ceilingTokens({ meta: { ceiling: { "1": 1024 } }, active_index: 1 })).toBe(1024);
  expect(ceilingTokens({ meta: { ceiling: { "0": null } }, active_index: 0 })).toBeNull();
  expect(ceilingTokens({ meta: { ceiling: { "0": "many" } }, active_index: 0 })).toBeNull();
  expect(ceilingTokens({ meta: { ceiling: { "1": 1024 } }, active_index: 0 })).toBeNull();
  expect(ceilingTokens({ meta: {}, active_index: 0 })).toBeNull();
});

/** The last reply's line under it, with the cause the server stored beside the mark. */
const cutBy = (cause: Record<string, unknown>, ceiling: number | null = null) =>
  ({ meta: { ceiling: { "0": ceiling }, cut: { "0": cause } }, active_index: 0 });

test("a reply cut at the ceiling its ai keeps says the figure, and offers to continue or to let Evermind set it", () => {
  expect(describeCut(cutBy({ mode: "fixed", length: "medium", thought: false }, 1024), t)).toEqual({
    text: 'chat.message.cutAtCeiling {"tokens":1024}', actions: ["extend", "letEvermind"],
  });
  // Its thinking counts toward that figure, which the line already says: lifting it is what helps.
  expect(describeCut(cutBy({ mode: "fixed", length: "medium", thought: true }, 1024), t)).toEqual({
    text: 'chat.message.cutAtCeiling {"tokens":1024}', actions: ["extend", "letEvermind"],
  });
});

test.each(["short", "medium", "long"] as const)("a reply that filled the room kept for a %s reply says so", (length) => {
  const said = describeCut(cutBy({ mode: "auto", length, thought: false }), t);
  expect(said).toEqual({
    text: `chat.message.cutRoom.${length}`,
    // Already long: nothing longer to ask for here.
    actions: length === "long" ? ["extend"] : ["extend", "longHere"],
  });
});

test("a reply whose thinking took the room says so, and offers to try again", () => {
  for (const mode of ["auto", "unsent"]) {
    expect(describeCut(cutBy({ mode, length: "short", thought: true }), t))
      .toEqual({ text: "chat.message.cutThought", actions: ["extend", "retry"] });
  }
});

test("a reply cut where its ai sends no ceiling says the server's most, and offers to continue", () => {
  expect(describeCut(cutBy({ mode: "unsent", length: "long", thought: false }), t))
    .toEqual({ text: "chat.message.cutAtCeilingUnset", actions: ["extend"] });
});

test("a reply with no cause stored says what it says today, the lift offered for a figure alone", () => {
  expect(describeCut({ meta: { ceiling: { "0": 1024 } }, active_index: 0 }, t))
    .toEqual({ text: 'chat.message.cutAtCeiling {"tokens":1024}', actions: ["letEvermind"] });
  expect(describeCut({ meta: { ceiling: { "0": null } }, active_index: 0 }, t))
    .toEqual({ text: "chat.message.cutAtCeilingUnset", actions: [] });
  // Another version's cause, or one this page cannot read, is no cause of this one.
  expect(describeCut({ meta: { ceiling: { "1": null }, cut: { "0": { mode: "auto", length: "short", thought: false } } }, active_index: 1 }, t))
    .toEqual({ text: "chat.message.cutAtCeilingUnset", actions: [] });
  expect(describeCut({ meta: { ceiling: { "0": null }, cut: { "0": { mode: "later", length: "short" } } }, active_index: 0 }, t))
    .toEqual({ text: "chat.message.cutAtCeilingUnset", actions: [] });
  expect(describeCut({ meta: { ceiling: { "0": null }, cut: { "0": { mode: "auto", length: "huge", thought: false } } }, active_index: 0 }, t))
    .toEqual({ text: "chat.message.cutAtCeilingUnset", actions: [] });
});

test("a version nothing cut has no line", () => {
  expect(describeCut({ meta: {}, active_index: 0 }, t)).toBeNull();
  expect(describeCut({ meta: { interrupted: [0] }, active_index: 0 }, t)).toBeNull();
  expect(describeCut({ meta: { ceiling: { "1": 1024 }, cut: { "1": { mode: "fixed", length: "short", thought: false } } }, active_index: 0 }, t)).toBeNull();
});

test.each(["en", "fr", "de", "es"] as const)("in %s, each cause has its words", (locale) => {
  const tr = (k: string, vars?: Record<string, string | number>) => translate(locale, k, vars);
  const causes = [
    { mode: "auto", length: "short", thought: false }, { mode: "auto", length: "medium", thought: false },
    { mode: "auto", length: "long", thought: false }, { mode: "auto", length: "short", thought: true },
  ];
  const lines = causes.map((cause) => describeCut(cutBy(cause), tr)!.text);
  for (const line of lines) expect(line).not.toContain("chat.message");
  expect(new Set(lines).size).toBe(lines.length);
  for (const key of ["extend", "retry", "longHere", "longHereDone"]) {
    expect(tr(`chat.message.${key}`)).not.toContain("chat.message");
  }
});
