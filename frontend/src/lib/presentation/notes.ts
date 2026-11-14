import type { Character } from "@/types";

// A card's presentation in each language it is written in: which versions the page offers, which
// one it shows first, and what each is called. The keys are the card's, kept as written; it is here
// that some of them become a name on a button.

export interface NotesVersion {
  /** The key of creator_notes_multilingual; null for the card's main field. */
  lang: string | null;
  text: string;
}

/** The versions by language the page offers at most, besides the main text: each is an option of
 *  the one control drawn on every visit, and two hundred hold every language with a two-letter code. */
export const NOTES_VERSIONS_BOUND = 200;

// RFC 5646 asks an application to take tags of 35 characters at least; none is longer.
const TAG_LENGTH = 35;
const TAG = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})*$/;

/** Whether a key of creator_notes_multilingual has the form of a language tag, and may be shown. */
export function isLanguageTag(key: string): boolean {
  return key.length <= TAG_LENGTH && TAG.test(key);
}

/** Code units, as the keys are sorted: lower case first, so that "FR-ca" goes beside "fr". */
const byUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The main text, then at most NOTES_VERSIONS_BOUND versions by language. Reads the keys once,
 *  stopping at the last version it keeps; sorts only those it keeps. */
export function notesVersions(character: Pick<Character, "creator_notes" | "creator_notes_multilingual">): NotesVersion[] {
  const main = character.creator_notes.trim();
  const kept: NotesVersion[] = [];
  const languages = character.creator_notes_multilingual ?? {};
  // A card often copies its main text under its own language: offered once.
  for (const lang in languages) {
    if (kept.length >= NOTES_VERSIONS_BOUND) break;
    if (!Object.hasOwn(languages, lang)) continue;
    const text = languages[lang];
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (trimmed && trimmed !== main) kept.push({ lang, text });
  }
  kept.sort((a, b) => byUnits((a.lang as string).toLowerCase(), (b.lang as string).toLowerCase()) || byUnits(a.lang as string, b.lang as string));
  return main ? [{ lang: null, text: character.creator_notes }, ...kept] : kept;
}

/** A tag's language alone, in lower case: "FR-ca" and "fr_CA" are "fr". */
const languageOf = (tag: string) => tag.toLowerCase().split(/[-_]/, 1)[0];

/** The index of the version to show first: the interface's language, else the main text, else
 *  English, else the first; -1 when there is none. */
export function chosenNotes(versions: NotesVersion[], locale: string): number {
  if (!versions.length) return -1;
  const wanted = languageOf(locale);
  const own = versions.findIndex((version) => version.lang !== null && isLanguageTag(version.lang) && languageOf(version.lang) === wanted);
  if (own >= 0) return own;
  const main = versions.findIndex((version) => version.lang === null);
  if (main >= 0) return main;
  const english = versions.findIndex((version) => version.lang !== null && isLanguageTag(version.lang) && languageOf(version.lang) === "en");
  return english >= 0 ? english : 0;
}

// One per interface language: building one for each option costs more than drawing it.
const names = new Map<string, Intl.DisplayNames | null>();

/** A language's name in the interface's language; the tag itself when it names none. Called only
 *  for a key isLanguageTag accepts. One Intl.DisplayNames per locale, built at its first call and
 *  kept in a module Map. */
export function languageName(lang: string, locale: string): string {
  try {
    let named = names.get(locale);
    if (named === undefined) {
      try {
        named = new Intl.DisplayNames([locale], { type: "language" });
      } catch {
        named = null;
      }
      names.set(locale, named);
    }
    // The underscore some cards write is no separator Intl reads.
    return named?.of(lang.replaceAll("_", "-")) || lang;
  } catch {
    return lang;
  }
}
