import { DEFAULT_LOCALE, type Locale } from "./config";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";

type Dict = Record<string, unknown>;
const DICTS: Record<Locale, Dict> = { en, de, es, fr };

function lookup(dict: Dict, key: string): string | undefined {
  let current: unknown = dict;
  for (const part of key.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Dict)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

// Made once a language: made for each sentence, they would cost more than the sentence.
const plurals: Partial<Record<Locale, Intl.PluralRules>> = {};

/** A key's sentence in a language, with its {words} filled in. A count takes the form its number
 *  takes in the language where the dictionary has one, under `<key>_one` and the like: "1 message". */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const count = vars?.count;
  const form = typeof count === "number"
    ? lookup(DICTS[locale], `${key}_${(plurals[locale] ??= new Intl.PluralRules(locale)).select(count)}`)
    : undefined;
  const raw = form ?? lookup(DICTS[locale], key) ?? lookup(DICTS[DEFAULT_LOCALE], key) ?? key;
  return interpolate(raw, vars);
}
