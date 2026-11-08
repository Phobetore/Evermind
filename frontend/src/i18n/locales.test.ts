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

describe("a sentence reads right where it is shown", () => {
  it("in French, with no line starting on ? ! ; : or », nor ending on «", () => {
    // A plain space before them is a place to break the line; a no-break one is not.
    const loose = flatten(fr).filter(([, v]) => typeof v === "string" && /[ ][?!;:»]|«[ ]/.test(v));
    expect(loose.map(([k]) => k)).toEqual([]);
  });

  it.each([
    ["es", "settings.about.updateAvailable", "Evermind {version} ya está disponible."],
    ["de", "cards.startChatModal.title", "Mit {name} spielen"],
    ["de", "errors.notSent", "Diese Nachricht wurde nicht gesendet. Drücke auf Senden, um sie noch einmal zu schicken."],
    // Every command shown starts Evermind itself.
    ["en", "settings.about.updateHint", "Stop Evermind, then run this from the folder you installed it in."],
    ["fr", "settings.about.updateHint", "Arrêtez Evermind, puis lancez ceci depuis le dossier où vous l'avez installé."],
    ["de", "settings.about.updateHint", "Halte Evermind an und führe dann das hier in dem Ordner aus, in dem du es installiert hast."],
    ["es", "settings.about.updateHint", "Detén Evermind y luego ejecuta esto en la carpeta donde lo instalaste."],
  ] as const)("in %s, %s", (locale, key, said) => {
    expect(new Map(flatten({ en, fr, de, es }[locale])).get(key)).toBe(said);
  });
});
