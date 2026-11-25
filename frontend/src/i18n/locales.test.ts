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
    ["de", "errors.notSent", "Diese Nachricht wurde nicht gesendet. Drücken Sie auf Senden, um sie noch einmal zu schicken."],
    // The colon after a word that ends a line stays with it, in French.
    ["fr", "characters.assist.statusWriting", "Écriture : {field}…"],
    ["fr", "characters.assist.missing", "Il manque encore : {fields}. Appuyez de nouveau sur Générer pour écrire seulement ce qui manque."],
    // A feminine and a masculine noun together take the masculine plural.
    ["es", "errors.modelNotFound", "El servicio no reconoce esta dirección ni este modelo. Compruébelos en Mis IA. Ha indicado: {message}"],
    ["en", "ways.length.hint", "How long the AI tries to write; Evermind keeps the room it needs, with nothing else to set."],
    // Every command shown starts Evermind itself.
    ["en", "settings.about.updateHint", "Stop Evermind, then run this from the folder you installed it in."],
    ["fr", "settings.about.updateHint", "Arrêtez Evermind, puis lancez ceci depuis le dossier où vous l'avez installé."],
    ["de", "settings.about.updateHint", "Halten Sie Evermind an und führen Sie dann das hier in dem Ordner aus, in dem Sie es installiert haben."],
    ["es", "settings.about.updateHint", "Detenga Evermind y luego ejecute esto en la carpeta donde lo instaló."],
    // One action, one name: "Continuar la respuesta" everywhere else.
    ["es", "chat.message.extend", "Continuar"],
    // What an AI reads at once is said in pages, in every language.
    ["en", "ways.card.reads", "{name} can read ≈ {pages:grouped} pages at once"],
    ["de", "ways.card.reads", "{name} kann ≈ {pages:grouped} Seiten auf einmal lesen"],
    ["es", "ways.card.reads", "{name} puede leer ≈ {pages:grouped} páginas de una vez"],
  ] as const)("in %s, %s", (locale, key, said) => {
    expect(new Map(flatten({ en, fr, de, es }[locale])).get(key)).toBe(said);
  });
});

describe("who a sentence speaks to", () => {
  // Evermind speaks to the person as "Sie" in German and "usted" in Spanish, as it says "vous" in
  // French. What is given as an example of words for the AI, or as a line of sample dialogue, is
  // not said to the person: those keys are named, and no other sentence may hold a familiar word.
  const notToThePerson = [
    "chat.input.modes.ooc.placeholder", "chat.panel.directive.description", "chat.panel.directive.placeholder",
    "settings.globalInstructionsPlaceholder", "characters.form.exampleDialoguesPlaceholder",
  ];
  // A word, and an order that opens a sentence. The orders are the ones these files once gave: in
  // Spanish only those that cannot be read as "it does", which a hint may well open on.
  const familiar = {
    de: [
      /(?<!\p{L})(du|dich|dir|dein|deine|deinen|deinem|deiner|deines|euch|euer|eure|kannst|möchtest|hast|bist|willst|musst)(?!\p{L})/iu,
      /(?:^|[.:!?…] )(Beschreibe|Denke|Drücke|Erhöhe|Erlaube|Erstelle|Füge|Gib|Halte|Hol|Installiere|Kürze|Lade|Melde|Nimm|Prüfe|Richte|Schreib|Sende|Setze|Sieh|Speichere|Trenne|Verbinde|Versuch|Versuche|Verwalte|Verwende|Warte|Wähle|Zeig|Ändere|Öffne)(?!\p{L})/u,
    ],
    es: [
      /(?<!\p{L})(tú|tu|tus|te|ti|contigo|puedes|quieres|tienes|necesitas|estás|eres|debes)(?!\p{L})/iu,
      /(?:^|[.:!?…] )(Detén|Mantén|Pon|Haz|Inténtalo|Acórtalo|Ábrelo|Compruébal[ao]s?|Revísal[ao]s?|Instálal[ao]s?)(?!\p{L})/u,
    ],
  };

  it.each([["de", de], ["es", es]] as const)("is the formal address in %s", (name, locale) => {
    const said = flatten(locale).filter(
      ([k, v]) => typeof v === "string" && !notToThePerson.includes(k) && familiar[name].some((word) => word.test(v)),
    );
    expect(said.map(([k]) => k)).toEqual([]);
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
    "settings.defaultConnectionLabel",
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
