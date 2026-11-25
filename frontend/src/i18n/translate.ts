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

// Made once a language: made for each sentence, they would cost more than the sentence.
const plurals: Partial<Record<Locale, Intl.PluralRules>> = {};
const numbers: Partial<Record<Locale, Intl.NumberFormat>> = {};
const grouped: Partial<Record<Locale, Intl.NumberFormat>> = {};
const wholePrices: Partial<Record<Locale, Intl.NumberFormat>> = {};
const pricesWithCents: Partial<Record<Locale, Intl.NumberFormat>> = {};
const tinyPrices: Partial<Record<Locale, Intl.NumberFormat>> = {};

function numberFormat(locale: Locale, modifier: string | undefined, value: number): Intl.NumberFormat {
  if (modifier === ":grouped") return (grouped[locale] ??= new Intl.NumberFormat(locale));
  if (modifier === ":price") {
    // A price that is not nothing but rounds to it at 4 decimals keeps its first figures, not "0,00".
    if (value > 0 && Math.round(value * 10_000) === 0) {
      return (tinyPrices[locale] ??= new Intl.NumberFormat(locale, { maximumSignificantDigits: 2 }));
    }
    return Number.isInteger(value)
      ? (wholePrices[locale] ??= new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }))
      : (pricesWithCents[locale] ??= new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
  }
  return (numbers[locale] ??= new Intl.NumberFormat(locale, { useGrouping: false }));
}

/** A number as the language writes it: "54,1" in French. Not grouped, as before: "16384 tokens";
 *  a sentence that tells large estimates asks for `{name:grouped}`: "31 000" in French; one that
 *  tells a price asks for `{name:price}`: "3" and "5,70", never "5,7", and "0,075" in full. */
function interpolate(locale: Locale, str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  return str.replace(/\{(\w+)(:grouped|:price)?\}/g, (whole, k, modifier) => {
    if (!(k in vars)) return whole;
    const value = vars[k];
    if (typeof value !== "number") return value;
    return numberFormat(locale, modifier, value).format(value);
  });
}

/** A key's sentence with its {words} filled in, in the form its count takes where there is one: `<key>_one`. */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const count = vars?.count;
  const form = typeof count === "number"
    ? lookup(DICTS[locale], `${key}_${(plurals[locale] ??= new Intl.PluralRules(locale)).select(count)}`)
    : undefined;
  const raw = form ?? lookup(DICTS[locale], key) ?? lookup(DICTS[DEFAULT_LOCALE], key) ?? key;
  return interpolate(locale, raw, vars);
}
