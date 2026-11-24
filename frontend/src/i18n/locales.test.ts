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

  it.each([["fr", fr], ["de", de], ["es", es]])("in %s, with no line starting on %", (_name, locale) => {
    const loose = flatten(locale).filter(([, v]) => typeof v === "string" && / %/.test(v));
    expect(loose.map(([k]) => k)).toEqual([]);
  });

  it.each([
    ["es", "settings.about.updateAvailable", "Evermind {version} ya está disponible."],
    ["de", "cards.startChatModal.title", "Mit {name} spielen"],
    ["de", "errors.notSent", "Diese Nachricht wurde nicht gesendet. Drücke auf Senden, um sie noch einmal zu schicken."],
    // The colon after a word that ends a line stays with it, in French.
    ["fr", "characters.assist.statusWriting", "Écriture : {field}…"],
    ["fr", "characters.assist.missing", "Il manque encore : {fields}. Appuyez de nouveau sur Générer pour écrire seulement ce qui manque."],
    // A feminine and a masculine noun together take the masculine plural.
    ["es", "errors.modelNotFound", "El servicio no reconoce esta dirección ni este modelo. Compruébalos en Mis IA. Ha indicado: {message}"],
    ["en", "settings.replyLengthHint", "Applies to every conversation. Evermind keeps the room needed by the AIs it sets itself; an AI with a fixed ceiling may cut long replies: see My AIs."],
    // Every command shown starts Evermind itself.
    ["en", "settings.about.updateHint", "Stop Evermind, then run this from the folder you installed it in."],
    ["fr", "settings.about.updateHint", "Arrêtez Evermind, puis lancez ceci depuis le dossier où vous l'avez installé."],
    ["de", "settings.about.updateHint", "Halte Evermind an und führe dann das hier in dem Ordner aus, in dem du es installiert hast."],
    ["es", "settings.about.updateHint", "Detén Evermind y luego ejecuta esto en la carpeta donde lo instalaste."],
  ] as const)("in %s, %s", (locale, key, said) => {
    expect(new Map(flatten({ en, fr, de, es }[locale])).get(key)).toBe(said);
  });
});

describe("who a sentence speaks to", () => {
  // The German of Evermind says "du". A "Sie" that means she or they is not an address, so the
  // keys where it does are named and every other "Sie" is read as the formal one.
  // The plan's closing pass (after task 10) switches de to Sie and es to usted: it removes both tests.
  const sheOrThey = [
    "characters.form.exampleDialoguesPlaceholder", "cards.exportWarning.assetsLeft", "cards.libraryModal.description",
    "ai.add.doneHint", "ai.add.doneHint_one", "ai.page.capAboveWindow",
  ];

  it("is du in German, never Sie, Ihr, Ihre or Ihnen", () => {
    const formal = flatten(de).filter(
      ([k, v]) => typeof v === "string" && (/\bIhr\w*|\bIhnen\b/.test(v) || (/\bSie\b/.test(v) && !sheOrThey.includes(k))),
    );
    expect(formal.map(([k]) => k)).toEqual([]);
  });

  it("is tú in Spanish, never usted or its imperatives", () => {
    // "elija" inside a sentence is a subjunctive about someone else; only a sentence that opens on one gives an order.
    const formal = flatten(es).filter(
      ([, v]) => typeof v === "string"
        && (/\busted(es)?\b/i.test(v) || /(^|[.:!?] )(Revise|Compruebe|Vuelva|Elija|Pulse|Añada|Revísela|Compruébela)\b/.test(v)),
    );
    expect(formal.map(([k]) => k)).toEqual([]);
  });
});

describe("the words that spoke of a connection", () => {
  // What a person reads when an AI cannot be reached, is missing or refuses: each is about an AI
  // or its service now, never about "the connection" of the form that no longer exists.
  const words = /connexion|connection|verbindung|conexi/i;
  const keys = [
    "errors.noConnection", "errors.modelUnreachable", "errors.modelOnlyThought", "errors.modelAuthRefused",
    "errors.modelNotFound", "errors.notFound.connection", "errors.briefTooLong", "errors.cardTooLong",
    "errors.contextTooSmall", "chat.message.cutAtCeiling", "chat.modelSilent.settingsLink",
    "cards.startChatModal.noConnectionOption", "cards.startChatModal.noConnectionWarning",
    "settings.defaultConnectionLabel", "settings.replyLengthHint",
  ];

  it.each([["en", en], ["fr", fr], ["de", de], ["es", es]])("are gone from the sentences about an AI, in %s", (_name, locale) => {
    const entries = new Map(flatten(locale));
    expect(keys.filter((k) => words.test(String(entries.get(k))))).toEqual([]);
  });

  it("send the person to My AIs by that name", () => {
    expect(new Map(flatten(en)).get("chat.modelSilent.settingsLink")).toBe("My AIs");
    expect(new Map(flatten(fr)).get("chat.modelSilent.settingsLink")).toBe("Mes IA");
  });

  it("leave nothing of the old form behind", () => {
    const left = flatten(en).map(([k]) => k).filter((k) => /^connections\.(benchmarkResult|temperatureHint)$|^settings\.(connectionsTitle|emptyState)/.test(k));
    expect(left).toEqual([]);
  });
});
