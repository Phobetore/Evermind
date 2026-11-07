import { describe, expect, it } from "vitest";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";

const flatten = (obj: object, prefix = ""): [string, unknown][] =>
  Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === "object"
      ? flatten(value, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value] as [string, unknown]],
  );

const reference = new Map(flatten(en));

// A missing key renders as nothing, which is harder to notice than a crash.
describe.each([
  ["de", de],
  ["es", es],
  ["fr", fr],
  ["en", en],
])("locale %s", (_name, locale) => {
  const entries = new Map(flatten(locale));

  it("has the keys of English and no others", () => {
    expect([...reference.keys()].filter((k) => !entries.has(k))).toEqual([]);
    expect([...entries.keys()].filter((k) => !reference.has(k))).toEqual([]);
  });

  it("has no empty strings", () => {
    const empty = [...entries].filter(([, v]) => typeof v === "string" && v.trim() === "");
    expect(empty.map(([k]) => k)).toEqual([]);
  });
});
